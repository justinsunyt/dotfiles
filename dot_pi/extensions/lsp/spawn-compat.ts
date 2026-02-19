/**
 * Node.js compatible subprocess wrapper that mimics Bun's subprocess API
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

export interface CompatSubprocess {
  stdin: CompatFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
  pid: number | undefined;
}

export interface CompatFileSink {
  write(data: Uint8Array): void;
  flush(): Promise<void>;
}

function nodeStreamToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

function createFileSink(stream: Writable): CompatFileSink {
  return {
    write(data: Uint8Array) {
      stream.write(Buffer.from(data));
    },
    async flush() {
      return new Promise<void>((resolve, reject) => {
        stream.once("drain", resolve);
        stream.once("error", reject);
        // If already drained, resolve immediately
        if (stream.writableLength === 0) {
          resolve();
        }
      });
    },
  };
}

export function compatSpawn(
  command: string,
  args: string[],
  options: { cwd: string }
): CompatSubprocess {
  const proc = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const exited = new Promise<number>((resolve, reject) => {
    proc.on("exit", (code) => {
      resolve(code ?? 0);
    });
    proc.on("error", reject);
  });

  return {
    stdin: createFileSink(proc.stdin!),
    stdout: nodeStreamToWebReadable(proc.stdout!),
    stderr: nodeStreamToWebReadable(proc.stderr!),
    exited,
    kill: () => proc.kill(),
    pid: proc.pid,
  };
}
