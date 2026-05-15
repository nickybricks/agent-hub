import * as net from "net";
import * as tls from "tls";

const HOSTS = ["imap.ionos.de", "sieve.ionos.de", "mail.ionos.de", "managesieve.ionos.de"];
const PORT = 4190;
const READ_MS = 3000;

function probe(opts: { host: string; port: number; tls: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    const done = (v: string | null) => {
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    const sock = opts.tls
      ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false, timeout: READ_MS })
      : net.connect({ host: opts.host, port: opts.port, timeout: READ_MS });

    sock.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 4096) done(data);
    });
    sock.on("error", () => done(data || null));
    sock.on("timeout", () => done(data || null));
    sock.on("close", () => done(data || null));
    setTimeout(() => done(data || null), READ_MS);
  });
}

async function main() {
  for (const host of HOSTS) {
    process.stdout.write(`\n=== ${host}:${PORT} ===\n`);
    for (const useTls of [false, true]) {
      const label = useTls ? "tls   " : "plain ";
      const out = await probe({ host, port: PORT, tls: useTls });
      if (!out) {
        console.log(`${label}: no response / refused`);
        continue;
      }
      const looksLikeSieve = /sieve|implementation/i.test(out);
      console.log(`${label}: ${looksLikeSieve ? "LOOKS LIKE SIEVE" : "non-sieve banner"}`);
      console.log(out.split("\n").slice(0, 12).map((l) => "    " + l).join("\n"));
    }
  }
}

main();
