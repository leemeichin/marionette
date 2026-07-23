#!/usr/bin/env node
import { run } from '../dist/cli.js';
process.exit(await run(process.argv.slice(2)));
