#!/usr/bin/env node

// This is the executable entry point for the obsidiant CLI
// It requires the compiled TypeScript output

const path = require('path');
const fs = require('fs');

// Path to the compiled main.js file
const mainPath = path.join(__dirname, '..', 'dist', 'main.js');

// Check if the compiled file exists
if (!fs.existsSync(mainPath)) {
  console.error('Error: Compiled TypeScript not found. Please run "npm run build" first.');
  process.exit(1);
}

// Require and run the compiled main module
const { runCLI } = require(mainPath);
runCLI();