// CR-LINKPREVIEW.1: https://bervo.ai/go/<label>/<page> -> a page that previews as "Sign in - Bervo Dashboard" (or
// "Setup - ...") and then opens https://<label>.bervo.ai/<page> through /go.js. All rules: functions/_lib/golink.js.
import { goResponse } from "../_lib/golink.js";

export async function onRequestGet(context) {
  return goResponse(context.request);
}

export async function onRequestHead(context) {
  const r = goResponse(context.request);
  return new Response(null, { status: r.status, headers: r.headers });
}
