import { connect } from "cloudflare:sockets";
import { createProxyHandler } from "../http.js";
import { createPagesBackend } from "./session.js";

// Pages Advanced Mode: all routes are handled here; no Worker/DO binding needed.
export default createProxyHandler(createPagesBackend(connect));
