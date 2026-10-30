/**
 * Benchmark watch on Snout's own side calls. Preloaded into every Node process of a session
 * (NODE_OPTIONS=--require), it stays inert unless the process is Snout (dist/snout.mjs) or was
 * started by one. In Snout processes it records, as JSON lines in SNOUT_GUARD_LOG: one "start"
 * line per process (proof the watch loaded), every socket connect and DNS lookup, every child
 * process, every native addon and every embedding-library import. It only records; it never
 * blocks. bench/memory-study.mjs reads the log after each session (snoutSideCalls).
 */
"use strict";
const LOG = process.env.SNOUT_GUARD_LOG;
const own = process.argv.slice(1).some((a) => /[\\/]snout[^\\/]*\.mjs$/i.test(a));
if (LOG && (own || process.env.SNOUT_GUARD_FROM)) {
  const fs = require("node:fs");
  const from = process.env.SNOUT_GUARD_FROM || "";
  process.env.SNOUT_GUARD_FROM = String(process.pid); // children inherit it
  const argv = process.argv.slice(1).map((a) => String(a).slice(0, 160));
  const log = (kind, target) => {
    try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, from, argv, kind, target }) + "\n"); } catch {}
  };
  log("start", own ? "snout" : "child of snout");

  const net = require("node:net");
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    try {
      const a = Array.isArray(args[0]) ? args[0][0] : args[0];
      const t = typeof a === "object" && a ? (a.path ? { path: a.path } : { host: a.host ?? "localhost", port: a.port }) : typeof a === "string" ? { path: a } : { host: typeof args[1] === "string" ? args[1] : "localhost", port: a };
      log("connect", t);
    } catch {}
    return connect.apply(this, args);
  };
  const dns = require("node:dns");
  const lookup = dns.lookup;
  dns.lookup = function (host, ...rest) { log("dns", { host }); return lookup.call(this, host, ...rest); };
  if (dns.promises?.lookup) {
    const plookup = dns.promises.lookup;
    dns.promises.lookup = function (host, ...rest) { log("dns", { host }); return plookup.call(this, host, ...rest); };
  }

  // fetch's own sockets bypass the patched connect, so it is wrapped by name.
  if (typeof globalThis.fetch === "function") {
    const fetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      try { log("fetch", { url: String(input?.url ?? input).slice(0, 200) }); } catch {}
      return fetch.call(this, input, init);
    };
  }

  const cp = require("node:child_process");
  const show = (file, args) => [file, ...(Array.isArray(args) ? args : [])].map((x) => String(x).slice(0, 200));
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
    const orig = cp[name];
    cp[name] = function (file, args, ...rest) { log("spawn", show(file, args)); return orig.call(this, file, args, ...rest); };
  }
  for (const name of ["exec", "execSync"]) {
    const orig = cp[name];
    cp[name] = function (command, ...rest) { log("spawn", [String(command).slice(0, 200)]); return orig.call(this, command, ...rest); };
  }

  const dlopen = process.dlopen;
  process.dlopen = function (module, filename, ...rest) { log("native", String(filename)); return dlopen.call(this, module, filename, ...rest); };

  const Module = require("node:module");
  Module.registerHooks?.({
    resolve(spec, ctx, next) {
      if (/transformers|onnxruntime/i.test(spec)) log("import", spec);
      return next(spec, ctx);
    },
  });
  Module.syncBuiltinESMExports();
}

const LOCAL = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/**
 * What Snout's own processes did during a session, from this watch's log lines: how many ran, local
 * connections (its own hook server, pipes), and any call that leaves the machine or uses a model:
 * Jev (TypeSafe), Snout Cloud, the embedding model, or anything else on the network.
 */
function snoutSideCalls(raw) {
  const out = { processes: 0, local: 0, network: [], jev: [], cloud: [], embedding: [], spawned: {} };
  for (const l of raw) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const t = e.target ?? {};
    if (e.kind === "start") out.processes++;
    else if (e.kind === "connect") (t.path || LOCAL.test(t.host ?? "localhost") ? out.local++ : out.network.push(`connect ${t.host}:${t.port}`));
    else if (e.kind === "dns") { if (!LOCAL.test(t.host ?? "")) out.network.push(`dns ${t.host}`); }
    else if (e.kind === "fetch") {
      let host = "";
      try { host = new URL(t.url).hostname; } catch { /* relative */ }
      if (/typesafe/i.test(t.url)) out.jev.push(t.url);
      else if (/usesnout|snout.*cloud/i.test(t.url)) out.cloud.push(t.url);
      else if (/huggingface|hf\.co/i.test(t.url)) out.embedding.push(t.url);
      else if (host && !LOCAL.test(host)) out.network.push(`fetch ${t.url}`);
      else out.local++;
    } else if (e.kind === "spawn") {
      const cmd = (Array.isArray(t) ? t : [t]).join(" ");
      if (/TYPESAFE/i.test(cmd)) out.jev.push(cmd.slice(0, 120));
      else if (/snout[^\\/ ]*\.mjs"?\s+(?:sync|login)\b/i.test(cmd)) out.cloud.push(cmd.slice(0, 120));
      else if (/snout[^\\/ ]*\.mjs"?\s+memory\s+model\b/i.test(cmd)) out.embedding.push(cmd.slice(0, 120));
      else if (/\b(?:curl|wget)\b/i.test(cmd)) out.network.push(cmd.slice(0, 120));
      const key = [String(t[0] ?? "").split(/[\\/]/).pop(), /snout[^\\/ ]*\.mjs$/i.test(String(t[1] ?? "")) ? `snout ${t[2] ?? ""}` : t[1] ?? ""].join(" ").trim();
      out.spawned[key] = (out.spawned[key] ?? 0) + 1;
    } else if (e.kind === "native" || e.kind === "import") { if (/onnx|transformers/i.test(String(t))) out.embedding.push(String(t)); }
  }
  return out;
}

module.exports = { snoutSideCalls };
