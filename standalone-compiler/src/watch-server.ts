import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as chokidar from "chokidar";
import * as path from "node:path";
import { IOInterface } from "../../desmoscript/src/io/io";
import { compileDesmoscript, formatError } from "../../desmoscript/src";
import { CompilerOutput } from "../../desmoscript/src/combined-functionality/full-compiler";
import { CodegenContext } from "../../desmoscript/src/codegen/codegen";

// runs a desmoscript server that watches for file changes
// and exposes an http endpoint for sending graph state into
// desmos
export async function runWatchServer(params: {
  entryPoint: string;
  errorContext: number;
  port: number;
  host: string;
  onCompileStart?: () => void;
  onCompile: (
    output: CompilerOutput,
    io: IOInterface,
    duration: number
  ) => void;
  onLoad: (host: string, port: number) => void;
  options: CodegenContext["options"];
}) {
  const io: IOInterface = {
    watchFile: (str, onchange) => {
      const watcher = chokidar.watch(str, {
        awaitWriteFinish: {
          pollInterval: 50,
          stabilityThreshold: 1000,
        },
      });
      watcher.on("change", onchange);
      watcher.on("delete", onchange);

      return () => watcher.close();
    },
    writeFile: (str, data) => fs.writeFile(str, data),
    readFile: async (str) => {
      const fileBuffer = await fs.readFile(str);
      const arr = new Uint8Array(fileBuffer.buffer.slice(0, fileBuffer.length));
      console.log("READ FILE: ", arr);
      return arr;
    },
    resolvePath: path.resolve,
    dirname: path.dirname,
    relativePath: path.relative,
  };

  const watchFiles = new Set<string>();

  let version = 0;

  const doCompile = async (watchFiles: Set<string>) => {
    params.onCompileStart?.();
    version++;
    const startTime = Date.now();
    const output = await compileDesmoscript(params.entryPoint, {
      unsavedFiles: new Map(),
      io,
      watchFiles,
      options: params.options,
    });
    const endTime = Date.now();
    params.onCompile(output, io, endTime - startTime);

    const watcher = chokidar.watch(Array.from(watchFiles.values()), {
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 1000,
      },
    });
    const recompile = (evtType: string) => (evt: any) => {
      watcher.close();
      compilerOutput = doCompile(watchFiles);
    };

    watcher.on("change", recompile("change"));
    watcher.on("unlink", recompile("unlink"));

    return { output, watchFiles };
  };

  let compilerOutput = doCompile(watchFiles);

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url == "/version") {
      res.end(version.toString());
      return;
    }

    const { output } = await compilerOutput;

    if (output.type == "success") {
      res.end(JSON.stringify(output.state));
    } else {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          type: "error",
          errors: output.errors,
        })
      );
    }
  });

  server.listen(params.port, params.host, undefined, () => {
    console.log(`Running HTTP server on http://${params.host}:${params.port}`);
    params.onLoad(params.host, params.port);
  });

  return () => {
    server.close();
  };
}
