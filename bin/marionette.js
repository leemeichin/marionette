#!/usr/bin/env node
import { run } from '../dist/cli.js';
process.exit(run(process.argv.slice(2)));
