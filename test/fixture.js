
function register(taskport) {
  taskport.register("noArgs", function() {
    return "string value";
  });
  
  taskport.register("noArgs2", function() {
    return [ 'value1', 'value2' ];
  });
  
  taskport.register("noArgs3", function() {
    return { key1: 'value1', key2: 'value2' }
  });

  taskport.register("noArgsAsyncResolve", function() {
    return new Promise((resolve) => {
      setTimeout(() => resolve("success"), 100);
    });
  });

  taskport.register("noArgsAsyncReject", function() {
    return new Promise((_, reject) => {
      setTimeout(() => reject("expected"), 100);
    });
  });

  taskport.register("noArgsThrowsError", function() {
    throw new Error("expected");
  });  
}

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
      // Export for CommonJS-like environments like Node
      module.exports = factory();
  } else {
      // Publish ourselves in browser globals (root is window)
      root.TaskPortFixture = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  return {
    register
  };
}));
