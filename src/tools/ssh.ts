// SSHRunner -- remote tool invocation via SSH
import { Client } from 'ssh2';
import type { ConnectConfig, ClientChannel } from 'ssh2';
import * as fs from 'node:fs';

export interface SSHConfig {
  host: string;
  user: string;
  key?: string;   // path to private key file
  port?: number;
}

export class SSHRunner {
  private client: Client;
  private connected = false;

  constructor(private readonly config: SSHConfig) {
    this.client = new Client();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cfg: ConnectConfig = {
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.user,
      };

      if (this.config.key) {
        cfg.privateKey = fs.readFileSync(this.config.key);
      } else {
        // use SSH agent when no key is specified
        cfg.agent = process.env['SSH_AUTH_SOCK'];
      }

      this.client
        .on('ready', () => {
          this.connected = true;
          resolve();
        })
        .on('error', (err: Error) => {
          const isAuthError =
            err.message.includes('Authentication') ||
            err.message.includes('auth') ||
            err.message.includes('permission denied');
          if (isAuthError) {
            // auth failures: fail immediately, no retry
            reject(new Error(`SSH auth failed: ${err.message}`));
          } else {
            reject(err);
          }
        })
        .connect(cfg);
    });
  }

  // runs a command via the ssh2 exec channel (not child_process)
  private runOnChannel(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          reject(err);
          return;
        }

        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        stream
          .on('close', () => {
            const out = Buffer.concat(chunks).toString('utf-8');
            const errOut = Buffer.concat(errChunks).toString('utf-8');
            resolve(out + (errOut ? `\nstderr: ${errOut}` : ''));
          })
          .on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          })
          .stderr.on('data', (chunk: Buffer) => {
            errChunks.push(chunk);
          });
      });
    });
  }

  exec(command: string, cwd?: string): Promise<string> {
    const cmd = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command;

    if (!this.connected) {
      return Promise.resolve('[ssh error] not connected');
    }

    return this.runOnChannel(cmd).catch(async (err: Error) => {
      // connection drop: try one reconnect
      this.connected = false;
      try {
        this.client = new Client();
        await this.connect();
        return await this.runOnChannel(cmd);
      } catch {
        // reconnect failed -- caller should mark agent errored
        return `[ssh error] ${err.message}`;
      }
    });
  }

  readFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(path);
        stream
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
          .on('error', reject);
      });
    });
  }

  writeFile(path: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(err);
          return;
        }
        const stream = sftp.createWriteStream(path);
        stream.on('error', reject).on('finish', resolve);
        stream.end(Buffer.from(content, 'utf-8'));
      });
    });
  }

  disconnect(): void {
    this.connected = false;
    this.client.end();
  }
}
