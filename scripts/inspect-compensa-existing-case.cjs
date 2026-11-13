"use strict";

// The former diagnostic entered through the home customer-search field.
// That route is removed. Existing cases require verified checkpoint navigation;
// never create another offer or search the customer portal as a substitute.
console.error("LEGACY_CLIENT_LOOKUP_REMOVED_USE_VERIFIED_CASE_CHECKPOINT");
process.exitCode = 1;
