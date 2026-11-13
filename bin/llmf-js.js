#!/usr/bin/env node

process.env.UV_THREADPOOL_SIZE ||= "16";

const { main } = await import("../src/cli.js");
process.exitCode = await main(process.argv.slice(2));
