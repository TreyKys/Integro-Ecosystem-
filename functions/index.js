// Import and re-export the original functions
const originalFunctions = require('./src/index');
Object.keys(originalFunctions).forEach(key => {
  exports[key] = originalFunctions[key];
});

// Import and re-export the new USSD functions
const ussdFunctions = require('./src/ussd');
Object.keys(ussdFunctions).forEach(key => {
  exports[key] = ussdFunctions[key];
});
