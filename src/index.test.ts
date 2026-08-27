import { describe, it, expect, vi } from 'vitest';
import { runControlMutation, type ControlMutationSpec, type ControlAuditRecord, type ControlHarnessDeps } from './index';

function numberSpec(over: Partial<ControlMutationSpec<number>> = {}) {
  const state = { value: 1 };
  const applied: number[] = [];
  const reverts: number[] = [];
  const spec: ControlMutationSpec<number> = {
    action: 'test:set',
    subject: 'thing',
    capturePrev: () => state.value,
    apply: async () => {
      state.value = 2;
      applied.push(2);
      return state.value;
    },
    revertTo: async (prev) => {
      state.value = prev;
      reverts.push(prev);
    },
    describe: (prev) => ({ from: prev, to: 2 }),
    ...over,
  };
  return { spec, state, applied, reverts };
}

function fakeAudit(): { rows: ControlAuditRecord[]; deps: ControlHarnessDeps } {
  const rows: ControlAuditRecord[] = [];
  let n = 0;
  return { rows, deps: { writeAudit: async (rec) => { rows.push(rec); return `aud-${++n}`; } } };
}

describe('runControlMutation — D-005 four guarantees', () => {
  it('dryRun previews without applying or auditing', async () => {
    const { spec, state, applied } = numberSpec();
    const { rows, deps } = fakeAudit();
    const out = await runControlMutation(spec, { dryRun: true }, deps);
    expect(out.dryRun).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.prev).toBe(1);
    expect(out.next).toBeUndefined();
    expect(out.preview).toEqual({ from: 1, to: 2 });
    expect(applied).toEqual([]);
    expect(state.value).toBe(1);
    expect(rows).toEqual([]);
  });

  it('apply path: applies, audits prev+next, and returns a one-call revert', async () => {
    const { spec, state, reverts } = numberSpec();
    const { rows, deps } = fakeAudit();
    const out = await runControlMutation(spec, {}, deps);
    expect(out.applied).toBe(true);
    expect(out.prev).toBe(1);
    expect(out.next).toBe(2);
    expect(out.auditId).toBe('aud-1');
    expect(rows[0]).toMatchObject({ action: 'test:set', subject: 'thing', prev: 1, next: 2 });
    expect(state.value).toBe(2);

    const rev = await out.revert!();
    expect(rev.reverted).toBe(true);
    expect(rev.next).toBe(1);
    expect(state.value).toBe(1);
    expect(reverts).toEqual([1]);
    expect(rows[1]).toMatchObject({ action: 'test:set:revert', revertOf: 'aud-1' });
  });

  it('auto-reverts when a verify fails under verifyMustPass (fail-safe)', async () => {
    const { spec, state, reverts } = numberSpec({ verify: async () => ({ ok: false, detail: 'no effect' }) });
    const { rows, deps } = fakeAudit();
    const out = await runControlMutation(spec, { verifyMustPass: true }, deps);
    expect(out.reverted).toBe(true);
    expect(out.applied).toBe(false);
    expect(state.value).toBe(1);
    expect(reverts).toEqual([1]);
    expect(out.revert).toBeUndefined();
    expect(rows[0]).toMatchObject({ reverted: true, verify: { ok: false } });
  });

  it('keeps a failed-verify change when verifyMustPass is false', async () => {
    const { spec, state } = numberSpec({ verify: async () => ({ ok: false }) });
    const out = await runControlMutation(spec, { verifyMustPass: false }, fakeAudit().deps);
    expect(out.reverted).toBeUndefined();
    expect(out.applied).toBe(true);
    expect(state.value).toBe(2);
  });

  it('propagates an apply throw (does not swallow)', async () => {
    const { spec } = numberSpec({ apply: async () => { throw new Error('apply boom'); } });
    await expect(runControlMutation(spec, {}, fakeAudit().deps)).rejects.toThrow(/apply boom/);
  });

  it('without an audit port, generates a local id (paper rig)', async () => {
    const { spec } = numberSpec();
    const out = await runControlMutation(spec, {}, { newId: () => 'local-1' });
    expect(out.auditId).toBe('local-1');
  });

  it('an audit writer returning "" yields no auditId (best-effort)', async () => {
    const { spec } = numberSpec();
    const out = await runControlMutation(spec, {}, { writeAudit: () => '' });
    expect(out.applied).toBe(true);
    expect(out.auditId).toBeUndefined();
  });

  it('records an explicit source audit id for a durable revert mutation', async () => {
    const { spec } = numberSpec({ action: 'test:set:revert', revertOf: 'aud-source' });
    const { rows, deps } = fakeAudit();
    await runControlMutation(spec, {}, deps);
    expect(rows[0]).toMatchObject({ action: 'test:set:revert', revertOf: 'aud-source' });
  });
});
