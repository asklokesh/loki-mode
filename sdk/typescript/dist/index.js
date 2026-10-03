"use strict";
/**
 * Loki Mode SDK - Public API
 *
 * loki-mode-sdk - TypeScript/Node.js SDK for the Loki Mode Control Plane API.
 *
 * Usage:
 *   import { AutonomiClient } from 'loki-mode-sdk';
 *   const client = new AutonomiClient({ baseUrl: 'http://localhost:57374', token: 'loki_xxx' });
 *   const projects = await client.listProjects();
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotAvailableOnControlPlaneError = exports.NotFoundError = exports.ForbiddenError = exports.AuthenticationError = exports.AutonomiError = exports.AutonomiClient = void 0;
// Main client
var client_js_1 = require("./client.js");
Object.defineProperty(exports, "AutonomiClient", { enumerable: true, get: function () { return client_js_1.AutonomiClient; } });
// Errors
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "AutonomiError", { enumerable: true, get: function () { return errors_js_1.AutonomiError; } });
Object.defineProperty(exports, "AuthenticationError", { enumerable: true, get: function () { return errors_js_1.AuthenticationError; } });
Object.defineProperty(exports, "ForbiddenError", { enumerable: true, get: function () { return errors_js_1.ForbiddenError; } });
Object.defineProperty(exports, "NotFoundError", { enumerable: true, get: function () { return errors_js_1.NotFoundError; } });
Object.defineProperty(exports, "NotAvailableOnControlPlaneError", { enumerable: true, get: function () { return errors_js_1.NotAvailableOnControlPlaneError; } });
//# sourceMappingURL=index.js.map