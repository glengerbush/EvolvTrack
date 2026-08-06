import { describe, expect, it } from 'vitest';
import { canonicalDomain } from './canonical-domain';

describe('canonical domain', () => {
  const timestamps = {
    createdAt: '2026-08-06T01:00:00.000Z',
    updatedAt: '2026-08-06T02:00:00.000Z',
  };

  it('accepts a valid Health Entry and discards unknown input', () => {
    expect(canonicalDomain.parse('entry', {
      id: 'dose-1',
      date: '2026-08-06',
      amountMg: 2.5,
      medication: 'Semaglutide (Ozempic / Wegovy)',
      unknown: 'must not survive',
      ...timestamps,
    })).toEqual({
      accepted: true,
      value: {
        id: 'dose-1',
        date: '2026-08-06',
        amountMg: 2.5,
        medication: 'Semaglutide (Ozempic / Wegovy)',
        ...timestamps,
      },
    });
  });

  it('normalizes legacy null optional Health Entry fields to absence', () => {
    expect(canonicalDomain.parse('entry', {
      id: 'entry-1',
      date: '2026-08-06',
      notes: null,
      medication: null,
      amountMg: null,
      fieldUpdatedAt: { notes: timestamps.updatedAt },
      ...timestamps,
    })).toEqual({
      accepted: true,
      value: {
        id: 'entry-1',
        date: '2026-08-06',
        fieldUpdatedAt: { notes: timestamps.updatedAt },
        ...timestamps,
      },
    });
  });

  it('rejects unsafe Health Entry values', () => {
    const valid = { id: 'entry-1', date: '2026-08-06', ...timestamps };
    const invalid = [
      { ...valid, id: '' },
      { ...valid, date: '2026-02-30' },
      { ...valid, date: '0000-01-01' },
      { ...valid, weightLbs: Number.POSITIVE_INFINITY },
      { ...valid, wellness: 11 },
      { ...valid, medication: 'Unknown medication' },
      { ...valid, updatedAt: 'not-a-timestamp' },
      { ...valid, fieldUpdatedAt: { wellness: 'not-a-timestamp' } },
    ];

    for (const value of invalid) {
      expect(canonicalDomain.parse('entry', value)).toEqual({ accepted: false });
    }
  });

  it('accepts a valid Vial and discards unknown input', () => {
    expect(canonicalDomain.parse('prescription', {
      id: 'vial-1',
      type: 'Tirzepatide (Mounjaro / Zepbound)',
      compoundDate: '2026-08-01',
      concentrationMgMl: 10,
      status: 'active',
      unknown: true,
      ...timestamps,
    })).toEqual({
      accepted: true,
      value: {
        id: 'vial-1',
        type: 'Tirzepatide (Mounjaro / Zepbound)',
        compoundDate: '2026-08-01',
        concentrationMgMl: 10,
        status: 'active',
        ...timestamps,
      },
    });
  });

  it('rejects unsafe Vial values', () => {
    const valid = { id: 'vial-1', ...timestamps };
    const invalid = [
      { ...valid, compoundDate: '2026-02-30' },
      { ...valid, costUsd: Number.NaN },
      { ...valid, type: 'Unknown medication' },
      { ...valid, status: 'invented' },
      { ...valid, fieldUpdatedAt: { costUsd: 'not-a-timestamp' } },
    ];

    for (const value of invalid) {
      expect(canonicalDomain.parse('prescription', value)).toEqual({ accepted: false });
    }
  });

  it('accepts syncable profile preferences without trusting device encryption state', () => {
    expect(canonicalDomain.parse('profile', {
      id: 'profile',
      passphraseEnabled: true,
      syncMode: 'migrating_to_plain',
      e2eeMigration: { id: 'untrusted-transition' },
      colorTheme: 'colorblind',
      colorModePreference: 'system',
      weightUnit: 'kg',
      healthHiddenCols: ['weight', 'wellness'],
      unknown: 'must not survive',
      ...timestamps,
    })).toEqual({
      accepted: true,
      value: {
        id: 'profile',
        passphraseEnabled: false,
        colorTheme: 'colorblind',
        colorModePreference: 'system',
        weightUnit: 'kg',
        healthHiddenCols: ['weight', 'wellness'],
        ...timestamps,
      },
    });
  });

  it('retains clocks only for canonical fields', () => {
    const entry = canonicalDomain.parse('entry', {
      id: 'entry-1',
      date: '2026-08-06',
      fieldUpdatedAt: {
        weightLbs: timestamps.updatedAt,
        unknown: 42,
      },
      ...timestamps,
    });
    expect(entry.accepted && entry.value.fieldUpdatedAt).toEqual({
      weightLbs: timestamps.updatedAt,
    });

    const profile = canonicalDomain.parse('profile', {
      id: 'profile',
      passphraseEnabled: true,
      colorTheme: 'default',
      fieldUpdatedAt: {
        colorTheme: timestamps.updatedAt,
        passphraseEnabled: 42,
        syncMode: { untrusted: true },
      },
      ...timestamps,
    });
    expect(profile.accepted && profile.value.fieldUpdatedAt).toEqual({
      colorTheme: timestamps.updatedAt,
    });
  });

  it('rejects unsafe profile preference values', () => {
    const valid = { id: 'profile', passphraseEnabled: false, ...timestamps };
    const invalid = [
      { ...valid, startWeight: Number.NEGATIVE_INFINITY },
      { ...valid, colorTheme: 'unknown' },
      { ...valid, colorModePreference: 'automatic' },
      { ...valid, weightUnit: 'stone' },
      { ...valid, healthColOrder: ['weight', 'unknown'] },
      { ...valid, symptomColors: { nausea: 42 } },
      { ...valid, fieldUpdatedAt: { weightUnit: 'not-a-timestamp' } },
    ];

    for (const value of invalid) {
      expect(canonicalDomain.parse('profile', value)).toEqual({ accepted: false });
    }
  });
});
