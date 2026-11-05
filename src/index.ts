import * as child_process from 'node:child_process';
import { stat, link, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import { setLine, reset } from 'terminal-set-line';

import { inParallel } from './in_parallel.js';

const execFile = promisify(child_process.execFile);

type File = {
  path: string;
  inode: number;
  size: number;
};

async function main() {
  setLine(0, 'Listing files in current directory...');
  const { stdout } = await execFile('find', ['.', '-type', 'f']);
  const filePaths = stdout.split('\n').filter(Boolean);
  setLine(0, `Listed ${filePaths.length} files in current directory.`);
  reset();

  const statFile = async (path: string): Promise<File> => {
    const { ino: inode, size } = await stat(path);
    return { path, inode, size };
  };

  const files: File[] = [];
  let percent = 0;

  const printStatProgress = () => {
    setLine(0, `Getting file sizes (${percent}%)...`);
  };
  printStatProgress();

  for await (const file of inParallel(statFile, 32, filePaths)) {
    files.push(file);
    const newPercent = Math.floor((100 * files.length) / filePaths.length);
    if (newPercent > percent) {
      percent = newPercent;
      printStatProgress();
    }
  }

  setLine(0, 'Got file sizes.');
  reset();

  const bySize = categorize(files, ({ size }) => `${size}`);

  let bytesRecoverable = 0;

  const thunks: (() => Promise<void>)[] = [];

  const optimize = async ([sizeStr, files]: [string, File[] | undefined]) => {
    if (!files || files.length < 2) return;
    const size = +sizeStr;

    for (let i = 0; i < files.length - 1; i++) {
      const a = files[i]!;
      for (let j = i + 1; j < files.length; j++) {
        const b = files[j]!;
        if (a.inode !== b.inode && await equivalent(a.path, b.path)) {
          console.log(`Found dup of ${a.path}: ${b.path}`);
          thunks.push(async () => {
            await unlink(b.path);
            await link(a.path, b.path);
          });
          bytesRecoverable += size;
        }
      }
    }
  };

  console.log('Comparing files of the same size...');
  for await (const _ of inParallel(optimize, 8, Object.entries(bySize))) {
  }

  let recoverable = bytesRecoverable;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 'B';

  while (recoverable >= 1000) {
    recoverable /= 1000;
    unit = units[units.indexOf(unit) + 1]!;
  }

  console.log(`\n${bytesRecoverable} bytes recoverable (${recoverable.toFixed(1)} ${unit}).`);

  const rl = createInterface(process.stdin, process.stdout);
  const answer = await rl.question('Type YES to proceed: ');
  rl.close();

  if (answer !== 'YES') {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('Recovering storage...');

  for (const thunk of thunks) {
    await thunk();
  }

  console.log('Done');
}

async function equivalent(a: string, b: string) {
  try {
    await execFile('diff', ['-q', a, b]);
    return true;
  } catch {
    return false;
  }
}

function categorize<T, Keys extends string>(items: T[], getCategory: (x: T) => Keys) {
  const r: { [K in Keys]?: T[] } = {};

  for (const item of items) {
    const category = getCategory(item);
    if (r[category]) {
      r[category].push(item);
    } else {
      r[category] = [item];
    }
  }

  return r;
}

await main();
