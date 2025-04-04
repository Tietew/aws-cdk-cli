import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import * as glob from 'glob';

// namespace object imports won't work in the bundle for function exports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const archiver = require('archiver');

type EventEmitter = (x: string) => void;

export async function zipDirectory(
  directory: string,
  outputFile: string,
  eventEmitter: EventEmitter,
): Promise<void> {
  // We write to a temporary file and rename at the last moment. This is so that if we are
  // interrupted during this process, we don't leave a half-finished file in the target location.
  const temporaryOutputFile = `${outputFile}.${randomString()}._tmp`;
  await writeZipFile(directory, temporaryOutputFile);
  await moveIntoPlace(temporaryOutputFile, outputFile, eventEmitter);
}

function writeZipFile(directory: string, outputFile: string): Promise<void> {
  return new Promise(async (ok, fail) => {
    // The below options are needed to support following symlinks when building zip files:
    // - nodir: This will prevent symlinks themselves from being copied into the zip.
    // - follow: This will follow symlinks and copy the files within.
    const globOptions = {
      dot: true,
      nodir: true,
      follow: true,
      cwd: directory,
    };
    const files = glob.sync('**', globOptions); // The output here is already sorted

    const output = createWriteStream(outputFile);

    const archive = archiver('zip');
    archive.on('warning', fail);
    archive.on('error', fail);

    // archive has been finalized and the output file descriptor has closed, resolve promise
    // this has to be done before calling `finalize` since the events may fire immediately after.
    // see https://www.npmjs.com/package/archiver
    output.once('close', ok);

    archive.pipe(output);

    // Append files serially to ensure file order
    for (const file of files) {
      const fullPath = path.resolve(directory, file);
      // There are exactly 2 promises
      // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
      const [data, stat] = await Promise.all([fs.readFile(fullPath), fs.stat(fullPath)]);
      archive.append(data, {
        name: file,
        date: new Date('1980-01-01T00:00:00.000Z'), // reset dates to get the same hash for the same content
        mode: stat.mode,
      });
    }

    await archive.finalize();
  });
}

/**
 * Rename the file to the target location, taking into account:
 *
 * - That we may see EPERM on Windows while an Antivirus scanner still has the
 *   file open, so retry a couple of times.
 * - This same function may be called in parallel and be interrupted at any point.
 */
async function moveIntoPlace(source: string, target: string, eventEmitter: EventEmitter) {
  let delay = 100;
  let attempts = 5;
  while (true) {
    try {
      // 'rename' is guaranteed to overwrite an existing target, as long as it is a file (not a directory)
      await fs.rename(source, target);
      return;
    } catch (e: any) {
      if (e.code !== 'EPERM' || attempts-- <= 0) {
        throw e;
      }
      eventEmitter(e.message);
      await sleep(Math.floor(Math.random() * delay));
      delay *= 2;
    }
  }
}

function sleep(ms: number) {
  return new Promise((ok) => setTimeout(ok, ms));
}

function randomString() {
  return Math.random()
    .toString(36)
    .replace(/[^a-z0-9]+/g, '');
}
