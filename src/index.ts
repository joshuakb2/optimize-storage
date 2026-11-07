import * as child_process from 'node:child_process';
import { stat, link, unlink, open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';

import { setLine, reset } from 'terminal-set-line';

import { collect, inParallel } from './in_parallel.js';

type File = {
  inode: number;
  path: string;
  paths: string[];
  size: number;
};

type StatusPrinter = {
  line: number;
  print: () => void;
};

type Direction = 'left' | 'right';

async function main() {
  setLine(0, 'Listing files in current directory...');
  const filePaths = await collect(listFiles());
  setLine(0, `Listed ${filePaths.length} files in current directory.`);
  reset();

  let blockSize!: number;

  const statFile = async (path: string): Promise<File> => {
    const { ino: inode, size, blksize } = await stat(path);
    blockSize = blksize;
    return { path, paths: [path], inode, size };
  };

  const inodes = new Map<number, File>();
  let percent = 0;

  const printStatProgress = () => {
    setLine(0, `Getting file sizes (${percent}%)...`);
  };
  printStatProgress();

  let i = 0;
  for await (const file of inParallel(statFile, 32, filePaths)) {
    i++;
    const existing = inodes.get(file.inode);
    if (existing) {
      existing.paths.push(file.path);
    } else {
      inodes.set(file.inode, file);
    }
    const newPercent = Math.floor((100 * i) / filePaths.length);
    if (newPercent > percent) {
      percent = newPercent;
      printStatProgress();
    }
  }

  setLine(0, 'Got file sizes.');
  reset();

  const bySize = categorize(inodes.values(), ({ size }) => size);

  let bytesRecoverable = 0;

  const pruneThunks: (() => Promise<void>)[] = [];
  const statusPrinters: StatusPrinter[] = [];

  const findDuplicates = async ([size, files]: [number, File[]]) => {
    if (files.length < 2) return;

    const fileCount = files.length;
    let dups = 0;
    let percent = 0;

    const status: StatusPrinter = {
      line: overallStatus.line++,
      print: () => {
        setLine(status.line, `${size} bytes (${fileCount} files) (${dups} dups) (${percent}%)`);
      },
    };

    overallStatus.print();

    statusPrinters.splice(-1, 0, status);
    status.print();

    type TreeNode = {
      file: File;
      height: number;
      left?: TreeNode | undefined;
      right?: TreeNode | undefined;
    };

    let tree: TreeNode = {
      file: files[0]!,
      height: 1,
    };

    const a = Buffer.alloc(blockSize);
    const b = Buffer.alloc(blockSize);

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

    const insert = async (node: TreeNode, newNode: TreeNode): Promise<TreeNode> => {
      const result = await compareFiles(newNode, node);

      switch (result) {
        case 'LT':
          if (node.left) {
            node.left = await insert(node.left, newNode);
            if (getBalance(node) > 1) {
              if (getBalance(node.left) < 0) {
                node.left = rotate(node.left, node.left.right!, 'right', 'left');
              }
              return rotate(node, node.left, 'left', 'right');
            }
          } else {
            node.left = newNode;
          }
          updateHeight(node);
          return node;

        case 'GT':
          if (node.right) {
            node.right = await insert(node.right, newNode);
            if (getBalance(node) < -1) {
              if (getBalance(node.right) > 0) {
                node.right = rotate(node.right, node.right.left!, 'left', 'right');
              }
              return rotate(node, node.right, 'right', 'left');
            }
          } else {
            node.right = newNode;
          }
          updateHeight(node);
          return node;

        case 'EQ':
          pruneThunks.push(async () => {
            for (const path of newNode.file.paths) {
              await unlink(path);
              await link(node.file.path, path);
            }
          });
          bytesRecoverable += size;
          dups++;
          status.print();
          return node;
      }
    };

    const rotate = (root: TreeNode, newRoot: TreeNode, heavy: Direction, light: Direction) => {
      root[heavy] = newRoot[light];
      newRoot[light] = root;

      updateHeight(root);
      updateHeight(newRoot);

      return newRoot;
    };

    const updateHeight = (tree: TreeNode) => {
      tree.height = 1 + Math.max(tree.left?.height ?? 0, tree.right?.height ?? 0);
    };

    const getBalance = (node: TreeNode) => (node.left?.height ?? 0) - (node.right?.height ?? 0);

    for (let i = 1; i < files.length; i++) {
      const file = files[i]!;
      const node: TreeNode = { file, height: 1 };
      tree = await insert(tree, node);

      const total = files.length - 1;
      const done = i;
      const newPercent = Math.floor((100 * done) / total);
      if (newPercent > percent) {
        percent = newPercent;
        status.print();
      }
    }

    percent = 100;

    // Since we're done, move our status line above all the in-progress status lines.
    const myIndex = statusPrinters.indexOf(status);

    if (myIndex !== 0) {
      status.line = statusPrinters[0]!.line;

      for (let i = myIndex - 1; i >= 0; i--) {
        statusPrinters[i]!.line++;
        statusPrinters[i]!.print();
      }
    }

    status.print();
    statusPrinters.splice(myIndex, 1);
  };

  console.log('Comparing files of the same size...');
  reset();

  // oxlint-disable-next-line unicorn/no-useless-spread
  const groups = [...bySize.entries().filter(([, files]) => files.length > 1)].sort(
    ([a], [b]) => a - b,
  );
  let groupsCompleted = 0;

  const overallStatus: StatusPrinter = {
    line: 0,
    print: () =>
      setLine(overallStatus.line, `Groups completed: (${groupsCompleted}/${groups.length})`),
  };
  statusPrinters.push(overallStatus);
  overallStatus.print();

  for await (const _ of inParallel(findDuplicates, 8, groups)) {
    groupsCompleted++;
    overallStatus.print();
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

  for (const thunk of pruneThunks) {
    await thunk();
  }

  console.log('Done');
}

function listFiles(): AsyncIterable<string> {
  const p = child_process.spawn('find', ['.', '-xdev', '-type', 'f'], {
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

function categorize<T, Keys>(items: Iterable<T>, getCategory: (x: T) => Keys) {
  const r = new Map<Keys, T[]>();

  for (const item of items) {
    const category = getCategory(item);
    let arr = r.get(category);
    if (arr) {
      arr.push(item);
    } else {
      r.set(category, [item]);
    }
  }

  return r;
}

await main();
