import * as child_process from 'node:child_process';
import { stat, link, unlink, open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';

import { setLine, reset } from 'terminal-set-line';

import { collect, inParallel } from './in_parallel.js';

type File = {
  path: string;
  inode: number;
  size: number;
};

async function main() {
  setLine(0, 'Listing files in current directory...');
  const filePaths = await collect(listFiles());
  setLine(0, `Listed ${filePaths.length} files in current directory.`);
  reset();

  const statFile = async (path: string): Promise<File> => {
    const { ino: inode, size } = await stat(path);
    return { path, inode, size };
  };

  const inodesSeen = new Set<number>();
  const files: File[] = [];
  let percent = 0;

  const printStatProgress = () => {
    setLine(0, `Getting file sizes (${percent}%)...`);
  };
  printStatProgress();

  for await (const file of inParallel(statFile, 32, filePaths)) {
    if (!inodesSeen.has(file.inode)) {
      inodesSeen.add(file.inode);
      files.push(file);
    }
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

  let line = 0;

  const optimize = async ([sizeStr, files]: [string, File[] | undefined]) => {
    if (!files || files.length < 2) return;
    const size = +sizeStr;

    const myline = line++;
    const fileCount = files.length;
    let dups = 0;
    let percent = 0;

    const printStatus = () => {
      setLine(myline, `Size = ${size} (${fileCount} files) (${dups} dups) (${percent}%)`);
    };
    printStatus();

    type TreeNode = {
      file: File;
      height: number;
      left?: TreeNode;
      right?: TreeNode;
    };

    let tree: TreeNode = {
      file: files[0]!,
      height: 1,
    };

    const a = Buffer.alloc(1000);
    const b = Buffer.alloc(1000);

    const compareFiles = async (an: TreeNode, bn: TreeNode) => {
      const af = await open(an.file.path, 'r');
      const bf = await open(bn.file.path, 'r');

      try {
        while (true) {
          const [{ bytesRead }] = await Promise.all([af.read(a), bf.read(b)]);
          if (bytesRead === 0) return 'EQ';

          const r = a.compare(b, 0, bytesRead, 0, bytesRead);
          if (r < 0) return 'LT';
          if (r > 0) return 'GT';
        }
      } finally {
        af.close();
        bf.close();
      }
    };

    const placeNode = async (tree: TreeNode, newNode: TreeNode) => {
      const result = await compareFiles(newNode, tree);

      switch (result) {
        case 'LT':
          if (tree.left) {
            await placeNode(tree.left, newNode);
          } else {
            tree.left = newNode;
          }
          return balance(tree);
        case 'GT':
          if (tree.right) {
            await placeNode(tree.right, newNode);
          } else {
            tree.right = newNode;
          }
          return balance(tree);
        case 'EQ':
          thunks.push(async () => {
            await unlink(newNode.file.path);
            await link(tree.file.path, newNode.file.path);
          });
          bytesRecoverable += size;
          dups++;
          printStatus();
          return tree;
      }
    };

    const balance = async (tree: TreeNode) => {
      const { left, right } = tree;
      if (left && left.height - (right?.height ?? 0) > 1) {
        left.right = await merge(tree, left.right);
        left.height = 1 + Math.max(left.left?.height ?? 0, left.right?.height ?? 0);
        return left;
      }

      if (right && right.height - (left?.height ?? 0) > 1) {
        right.left = await merge(tree, right.left);
        right.height = 1 + Math.max(right.left?.height ?? 0, right.right?.height ?? 0);
        return right;
      }

      return tree;
    };

    const merge = async (a: TreeNode, b: TreeNode | undefined) => {
      if (!b) return a;
      if ((await compareFiles(a, b)) === 'LT') {
        if ((a.right?.height ?? 0) < (b.left?.height ?? 0)) {
          a.right = await merge(b, a.right);
          a.height = 1 + Math.max(a.left?.height ?? 0, a.right?.height ?? 0);
          return a;
        } else {
          b.left = await merge(a, b.left);
          b.height = 1 + Math.max(b.left?.height ?? 0, b.right?.height ?? 0);
          return b;
        }
      } else {
        if ((a.left?.height ?? 0) < (b.right?.height ?? 0)) {
          a.left = await merge(b, a.left);
          a.height = 1 + Math.max(a.right?.height ?? 0, a.left?.height ?? 0);
          return a;
        } else {
          b.right = await merge(a, b.right);
          b.height = 1 + Math.max(b.right?.height ?? 0, b.left?.height ?? 0);
          return b;
        }
      }
    };

    for (let i = 1; i < files.length; i++) {
      const file = files[i]!;
      const node: TreeNode = { file, height: 1 };
      tree = await placeNode(tree, node);

      const total = files.length - 1;
      const done = i - 1;
      const newPercent = Math.floor((100 * done) / total);
      if (newPercent > percent) {
        percent = newPercent;
        printStatus();
      }
    }

    percent = 100;
    printStatus();
  };

  console.log('Comparing files of the same size...');
  reset();
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

function listFiles(): AsyncIterable<string> {
  const p = child_process.spawn('find', ['.', '-type', 'f'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const decoder = new StringDecoder('utf-8');
  let text = '';
  const queue: IteratorResult<string, undefined>[] = [];
  let next: PromiseWithResolvers<IteratorResult<string, undefined>> | undefined;

  const newPromise = () => {
    next = Promise.withResolvers<IteratorResult<string, undefined>>();
    return next.promise;
  };

  const kick = () => {
    if (next) {
      const result = queue.shift();
      if (result) {
        next.resolve(result);
        next = undefined;
      }
    }
  };

  p.stdout.on('data', (data) => {
    text += decoder.write(data);
    const lines = text.split('\n');
    queue.push(...lines.slice(0, -1).map((value) => ({ value })));
    text = lines.at(-1)!;
    kick();
  });

  p.stdout.on('end', () => {
    text += decoder.end();
    const lines = text.split('\n');
    queue.push(...lines.filter(Boolean).map((value) => ({ value })));
    queue.push({ done: true, value: undefined });
    kick();
  });

  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const promise = newPromise();
        kick();
        return promise;
      },
    }),
  };
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
