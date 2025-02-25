import { URL_PREFIX, parseUrl } from "./url.js";
import { Namespace } from './namespace.js';

const MODULE_VERSION = "2.0.1";

const DEFAULT_SETTINGS = {
  /** Whether TaskPort should log errors thrown by JavaScript functions to the console */
  logCallErrors: false,

  /** Whether TaskPort should log errors occuring in the interop mechanism to the console */
  logInteropErrors: true
};

var globalSettings = DEFAULT_SETTINGS;

const defaultNamespace = new Namespace('unversioned');
const namespaces = {};

/** Returns a promise regardless of the return value of the fn */
function callAndReturnPromise(fn, args) {
  try {
    return Promise.resolve(fn(args));
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Returns an object containing all meaningful information
 * from a given Error instance available across different platforms.
 * 
 * Specifically it would have:
 * - name: string containing the type of the error object, e.g. 'ReferenceError'
 * - message: string which could be empty
 * - stackLines: platform-specific stack trace for the error broken down into separate lines as an array of strings
 * - cause: nested object provided as a cause for the `Error`, whcih is processed recursively if it itself is an `Error`, or `null`
 * 
 * If invoked with something which isn't an error, returns passes the argument through unchanged.
 */
function describeError(error) {
  if (error instanceof Error) {
    // unpacking subtypes of Error explicity, as JSON.stingify() does not extract any useful information
    const {name, message, cause, stack} = error;
    const stackLines = (stack === undefined)? [] : stack.split(/\n/).slice(1);
    return { name, message, cause: describeError(cause), stackLines };
  } else if (error === undefined) {
    // this makes sure that cause field is always present when invoked recursively
    return null;
  } else {
    return error;
  }
}

/**
 * Configure JavaScript environment in the current JavaScript context (e.g. web page) to enable interop calls.
 * 
 * @param {{ logErrors?: boolean } | undefined} settings additional parameters
 * @param {XMLHttpRequest | undefined} xhrProto prototype of XHR to install TaskPort interceptor to (Node.js-only)
 */
export function install(settings, xhrProto) {
  if (typeof settings === 'object') {
    globalSettings = { ...DEFAULT_SETTINGS, ...settings };
  }
  if (xhrProto === undefined) {
    xhrProto = XMLHttpRequest.prototype;
  }
  xhrProto.__elm_taskport_open = xhrProto.open;
  xhrProto.open = function (method, url, async, user, password) {
    if (url.indexOf(URL_PREFIX) === 0) {
      this.__elm_taskport_url = url;
      this.__elm_taskport_function_call = true;

      // making certain properties writable so that they can be manipulated
      Object.defineProperty(this, "responseType", { writable: true });
      Object.defineProperty(this, "response", { writable: true });
      Object.defineProperty(this, "status", { writable: true });

      // attempting to parse the url
      const parsedUrl = parseUrl(url);
      if (parsedUrl === undefined) {
        this.__elm_taskport_error = [ 400, `Cannot decode TaskPort url ${url}. `
          + `Did you update TaskPort package to a new version, but forgot to update the JavaScript code it requires?` ];

      } else {
        const { namespaceName, functionName, apiVersion, namespaceVersion } = parsedUrl;        
        if (apiVersion !== MODULE_VERSION) {
          this.__elm_taskport_error = [ 400, `TaskPort version conflict. Elm-side is ${apiVersion}, but JavaScript-side is ${MODULE_VERSION}. `
            + `Did you update TaskPort package to a new version, but forgot to update the JavaScript code it requires?` ];

        } else if (namespaceName === undefined) {
          this.__elm_taskport_function_name = functionName

          // looking for the function is in the default namespace
          const fn = defaultNamespace.find(functionName);
          if (fn !== undefined) {
            this.__elm_taskport_function = fn;
          } else {
            this.__elm_taskport_error = [ 404, `Cannot find function '${functionName}' in the default namespace. `
              + `The default namespace has the following functons registered:\n`
              + defaultNamespace.names().join("\n") ]
          }

        } else {
          this.__elm_taskport_function_name = namespaceName + "/" + functionName;

          // looking for the function in a specified namespace
          if (namespaceName in namespaces) {
            const ns = namespaces[namespaceName];
            if (ns.version === namespaceVersion) {
              const fn = ns.find(functionName);
              if (fn !== undefined) {
                this.__elm_taskport_function = fn;
              } else {
                this.__elm_taskport_error = [ 404, `Cannot find function '${functionName}' in namespace ${namespaceName}. `
                  + `This namespace has only the following functons registered with it:\n`
                  + ns.names().join("\n") ];
              }

            } else {
              this.__elm_taskport_error = [ 400, `The interop call expected namespace '${namespaceName}' to have version '${namespaceVersion}', `
                + `but it is registered with version '${ns.version}'. `
                + `Did you update the Elm package to a new version, but forgot to update the JavaScript code it requires?` ];
            }

          } else {
            const knownNamespaces = Object.keys(namespaces);
            this.__elm_taskport_error = [ 404, `Namespace '${namespaceName}' is not registered with TaskPort. `
              + `Did you follow the instructions to install required JavaScript code for the package? `
              + (knownNamespaces.length == 0)? `There are no namespaces registered with TaskPort.` :
                `Only the following namespaces are known to TaskPort:\n` + knownNamespaces.join("\n") ]
          }
        }
      }
    }
    // still have to invoke the original open() otherwise XHR behaves unpredictably
    return this.__elm_taskport_open(method, url, true, user, password);
  };

  if (typeof ProgressEvent === 'function') {
    // XMLHttpRequest in browsers require a ProgressEvent object as a parameter for dispatchEvent()
    xhrProto.__elm_taskport_dispatch_event = function (eventName) { this.dispatchEvent(new ProgressEvent(eventName)) };
  } else {
    // XMLHttpRequest in Node.js (as provided by xmlhttprequest NPM package @1.8.0) requires a string as parameter for dispatchEvent()
    xhrProto.__elm_taskport_dispatch_event = xhrProto.dispatchEvent;
  }

  xhrProto.__elm_taskport_send = xhrProto.send;
  xhrProto.send = function (body) {
    if (!this.__elm_taskport_function_call) {
      // fall back to the default implementation when not intercepting
      return this.__elm_taskport_send(body);
    }

    if (this.__elm_taskport_function !== undefined) {
      // requested function was found and all versions meet the expectations
      const parsedBody = JSON.parse(body);
      const promise = callAndReturnPromise(this.__elm_taskport_function, parsedBody);
      promise.then((res) => {
        this.responseType = 'json';
        this.response = (res === undefined)? 'null' : JSON.stringify(res); // force null if the function does not return a value
        this.status = 200;
        this.__elm_taskport_dispatch_event('load');
      }).catch((err) => {
        if (globalSettings.logCallErrors) {
          console.error("JavaScript function " + this.__elm_taskport_function_name + " thrown an error or returned a rejected Promise:", err);
        }

        this.status = 500;
        this.responseType = 'json';
        this.response = JSON.stringify(describeError(err));
        this.__elm_taskport_dispatch_event('load');
      });

    } else {
      if (this.__elm_taskport_error === undefined) {
        this.__elm_taskport_error == [ 400, "TaskPort call failed without an error message. This could indicate a bug in TaskPort itself." ];
      }
      const [status, message] = this.__elm_taskport_error;

      if (globalSettings.logInteropErrors) {
        console.error("Unable to execute the interop call. " + message);
      }

      this.status = status;
      this.responseType = 'text';
      this.response = this.__elm_taskport_function_name
      this.__elm_taskport_dispatch_event('load');
    }
  };
}

/**
 * Register given JavaScript function under a particular name in the default namespace to make it available for the interop.
 * If you are developing an Elm package that would need to invoke JavaScript code using TaskPort,
 * it is advisable to use package namespaces -- see `createNamespace` function for details.
 * 
 * @param {string} name
 * @param {(any) => any} fn
 */
export function register(name, fn) {
  defaultNamespace.register(name, fn);
}

/**
 * Creates a namespace for registering JavaScript function and making them available for the interop.
 * Namespaces are intended to be used by Elm package developers to eliminate the possibility
 * of JavaScript function name clashes with other Elm packages. Function namespaces are versioned,
 * which provide further safeguard against running incompatible versions of Elm and JavaScript code.
 * 
 * @param {string} name Elm package namespace
 * @param {string} version string encoding a semantic version of the JavaScript API
 * @returns {Namespace}
 */
export function createNamespace(name, version) {
  const ns = new Namespace(version);
  namespaces[name] = ns;
  return ns;
}
