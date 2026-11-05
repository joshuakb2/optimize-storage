/**
 * Returns an async iterator for the results of running the given job for each given input, in
 * parallel, but not exceeding maxAtOnce simultaneously.
 *
 * Results are yielded in order of completion, not necessarily in the order of their corresponding
 * inputs. Jobs are started in the order of the given inputs, however.
 */
export const inParallel = <Input, Output>(
  job: (item: Input) => Promise<Output>,
  maxAtOnce: number,
  inputs: Iterable<Input>,
): AsyncIterable<Output> => {
  // resultQueue contains the outputs of completed jobs that have not been consumed by the iterator yet.
  const resultQueue: Output[] = [];

  // Get new inputs out of here
  const inputIterator = inputs[Symbol.iterator]();

  // When the user has asked for the next promise, we can complete that promise with these functions.
  let resolve: ((value: Output) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;

  // If an error occurs and the user has not asked for the next promise yet, put it here.
  let error: Error | undefined;

  let iteratorDone = false;
  let jobsInProgress = 0;

  const onResolve = (output: Output) => {
    jobsInProgress--;
    if (resolve) resolve(output);
    else resultQueue.push(output);
    getUpToSpeed();
  };

  const onReject = (err: Error) => {
    jobsInProgress--;
    if (reject) reject(err);
    else if (!error) error = err;
    getUpToSpeed();
  };

  const getUpToSpeed = () => {
    if (iteratorDone || error) return;
    while (jobsInProgress + resultQueue.length < maxAtOnce) {
      const { done, value } = inputIterator.next();
      if (done) {
        iteratorDone = true;
        return;
      }
      job(value).then(onResolve, onReject);
      jobsInProgress++;
    }
  };

  getUpToSpeed();

  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (error) return Promise.reject(error);

        if (resultQueue.length > 0) {
          const result = resultQueue.shift() as Output;
          getUpToSpeed();
          return Promise.resolve({ done: false, value: result });
        }

        if (iteratorDone && jobsInProgress === 0)
          return Promise.resolve({ done: true, value: undefined });

        return new Promise((res, rej) => {
          resolve = output => {
            resolve = reject = null;
            res({ value: output });
          };
          reject = error => {
            resolve = reject = null;
            rej(error);
          };
        });
      },
    }),
  };
};

/** Collects all the outputs from an async iterable into an array. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const output = [];
  for await (const x of iter) {
    output.push(x);
  }
  return output;
}
