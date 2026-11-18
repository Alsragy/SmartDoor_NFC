import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/* ------------------------------------------------------------------ *
 * Terminal log simulasi blockchain.
 * SimulationService.sendToTerminal() mengirim POST /api/terminal-log
 * dengan body { message, type }; plugin ini mencetaknya berwarna di
 * terminal `npm run dev`.
 * ------------------------------------------------------------------ */

const LOG_ENDPOINT = '/api/terminal-log';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 400;

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GRAY = '\x1b[90m';

/** type -> [kode warna ANSI, label] */
const LOG_TYPES = {
  success: ['\x1b[32m', 'SUCCESS'],
  hashing: ['\x1b[33m', 'HASHING'],
  process: ['\x1b[33m', 'PROCESS'],
  block: ['\x1b[35m', 'BLOCK'],
  queue: ['\x1b[33m', 'QUEUE'],
  error: ['\x1b[31m', 'FAILED'],
  info: ['\x1b[36m', 'INFO'],
};

/** Buang karakter kontrol (termasuk ESC) agar payload tidak bisa menyuntik ANSI ke terminal. */
// eslint-disable-next-line no-control-regex
const stripControl = (value) => String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '').slice(0, MAX_MESSAGE_LENGTH);

function printLog({ message, type }) {
  const [color, label] = LOG_TYPES[type] ?? LOG_TYPES.info;
  const time = new Date().toLocaleTimeString('en-GB');
  console.log(
    `${GRAY}${time}${RESET} ${BOLD}\x1b[35m[DormChain]${RESET} ${color}${BOLD}[${label}]${RESET} ${color}${stripControl(message)}${RESET}`,
  );
}

function terminalLogPlugin() {
  return {
    name: 'dormchain-terminal-log',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        console.log(`\n  ${BOLD}\x1b[35m[DormChain]${RESET} Terminal log simulasi aktif di \x1b[36mPOST ${LOG_ENDPOINT}${RESET}\n`);
      });

      server.middlewares.use(LOG_ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Allow', 'POST');
          res.end();
          return;
        }

        let body = '';
        let tooLarge = false;

        req.on('data', (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY_BYTES) tooLarge = true;
        });

        req.on('end', () => {
          if (tooLarge) {
            res.statusCode = 413;
            res.end();
            return;
          }
          try {
            const payload = JSON.parse(body);
            if (!payload || typeof payload.message !== 'string') throw new Error('message wajib berupa string');
            printLog(payload);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"ok":true}');
          } catch (error) {
            console.log(`\x1b[31m[DormChain] Payload /api/terminal-log tidak valid: ${stripControl(error.message)}${RESET}`);
            res.statusCode = 400;
            res.end();
          }
        });

        req.on('error', () => {
          res.statusCode = 400;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), terminalLogPlugin()],
});
