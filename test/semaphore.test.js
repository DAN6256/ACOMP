import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Semaphore } from '../src/lib/semaphore.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

it('runs at most maxActive tasks and queues the rest in order', async () => {
  const sem = new Semaphore(1, 5);
  const order = [];
  const gate = deferred();

  const a = sem.run(async () => {
    order.push('a:start');
    await gate.promise;
    order.push('a:end');
  });
  const b = sem.run(async () => order.push('b'));

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sem.stats(), { active: 1, queued: 1, maxActive: 1, maxQueued: 5 });

  gate.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
  assert.equal(sem.stats().active, 0);
});

it('rejects with SERVER_BUSY when the queue is full', async () => {
  const sem = new Semaphore(1, 1);
  const gate = deferred();
  const a = sem.run(() => gate.promise);
  const b = sem.run(async () => {});

  await assert.rejects(sem.run(async () => {}), { status: 503, code: 'SERVER_BUSY' });
  gate.resolve();
  await Promise.all([a, b]);
});

it('releases the slot when a task throws', async () => {
  const sem = new Semaphore(1, 0);
  await assert.rejects(sem.run(async () => { throw new Error('boom'); }));
  await sem.run(async () => {});
  assert.equal(sem.stats().active, 0);
});
