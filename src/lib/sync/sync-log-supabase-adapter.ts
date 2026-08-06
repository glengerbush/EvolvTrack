import { supabase } from '$lib/auth/supabase';
import { requireAuthenticatedUser } from '$lib/sync/account-state';
import type {
  EncryptedSyncLogRow,
  PlainSyncLogRow,
  SyncLogAdapter,
  SyncLogReadOptions,
} from '$lib/sync/sync-log-adapter';

const PAGE_SIZE = 500;
type Page<T> = { data: T[] | null; error: unknown };

async function allPages<T>(fetchPage: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

type PlainWireRow = {
  id: string; aggregate: PlainSyncLogRow['aggregate']; op: PlainSyncLogRow['op']; payload: unknown;
  protocol_version: number; schema_version: number; created_at: string; inserted_at: string;
};
type EncryptedWireRow = {
  id: string; ciphertext: string; iv: string; protocol_version: number; encryption_version: number;
  dek_version: number; schema_version: number; created_at: string; inserted_at: string;
};

export const supabaseSyncLogAdapter: SyncLogAdapter = {
  isWriteModeRejection(error) {
    return typeof error === 'object' && error !== null
      && (error as { code?: unknown }).code === '42501';
  },

  watch(onChange, onAuthChange) {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const teardownChannel = () => {
      if (channel) void supabase.removeChannel(channel);
      channel = null;
    };
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      teardownChannel();
      const userId = session?.user?.id;
      onAuthChange(Boolean(userId));
      if (!userId) return;
      channel = supabase
        .channel('sync-changes')
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'sync_changes_encrypted', filter: `user_id=eq.${userId}`,
        }, onChange)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'sync_changes_plain', filter: `user_id=eq.${userId}`,
        }, onChange)
        .subscribe();
    });
    return () => {
      teardownChannel();
      data.subscription.unsubscribe();
    };
  },

  async readPlain(options: SyncLogReadOptions = {}) {
    const user = await requireAuthenticatedUser();
    const rows = await allPages<PlainWireRow>((from, to) => {
      let query = supabase
        .from('sync_changes_plain')
        .select('id,aggregate,op,payload,created_at,inserted_at,protocol_version,schema_version')
        .eq('user_id', user.id)
        .order('inserted_at', { ascending: true })
        .order('id', { ascending: true });
      if (options.after) query = query.gt('inserted_at', options.after);
      return query.range(from, to);
    });
    return rows.map((row) => ({
      id: row.id, aggregate: row.aggregate, op: row.op, payload: row.payload,
      protocolVersion: row.protocol_version, schemaVersion: row.schema_version,
      createdAt: row.created_at, insertedAt: row.inserted_at,
    }));
  },

  async readEncrypted(options: SyncLogReadOptions = {}) {
    const user = await requireAuthenticatedUser();
    const rows = await allPages<EncryptedWireRow>((from, to) => {
      let query = supabase
        .from('sync_changes_encrypted')
        .select('id,ciphertext,iv,created_at,inserted_at,protocol_version,encryption_version,dek_version,schema_version')
        .eq('user_id', user.id)
        .order(options.after ? 'inserted_at' : 'created_at', { ascending: true })
        .order('id', { ascending: true });
      if (options.after) query = query.gt('inserted_at', options.after);
      if (options.dekVersion !== undefined) query = query.eq('dek_version', options.dekVersion);
      return query.range(from, to);
    });
    return rows.map((row) => ({
      id: row.id, ciphertext: row.ciphertext, iv: row.iv,
      protocolVersion: row.protocol_version, encryptionVersion: row.encryption_version,
      dekVersion: row.dek_version, schemaVersion: row.schema_version,
      createdAt: row.created_at, insertedAt: row.inserted_at,
    }));
  },

  async writePlain(rows) {
    if (!rows.length) return;
    const user = await requireAuthenticatedUser();
    const { error } = await supabase.from('sync_changes_plain').upsert(rows.map((row) => ({
      id: row.id, user_id: user.id, aggregate: row.aggregate, op: row.op, payload: row.payload,
      protocol_version: row.protocolVersion, schema_version: row.schemaVersion, created_at: row.createdAt,
    })), { onConflict: 'user_id,id' });
    if (error) throw error;
  },

  async writeEncrypted(rows) {
    if (!rows.length) return;
    const user = await requireAuthenticatedUser();
    const { error } = await supabase.from('sync_changes_encrypted').upsert(rows.map((row) => ({
      id: row.id, user_id: user.id, ciphertext: row.ciphertext, iv: row.iv,
      protocol_version: row.protocolVersion, encryption_version: row.encryptionVersion,
      dek_version: row.dekVersion, schema_version: row.schemaVersion, created_at: row.createdAt,
    })), { onConflict: 'user_id,id' });
    if (error) throw error;
  },

  async deletePlain(ids) {
    if (ids && ids.length === 0) return 0;
    const user = await requireAuthenticatedUser();
    let query = supabase.from('sync_changes_plain').delete({ count: 'exact' }).eq('user_id', user.id);
    if (ids?.length) query = query.in('id', ids);
    const { error, count } = await query;
    if (error) throw error;
    return count ?? ids?.length ?? 0;
  },

  async deleteEncrypted(ids) {
    if (ids && ids.length === 0) return 0;
    const user = await requireAuthenticatedUser();
    let query = supabase.from('sync_changes_encrypted').delete({ count: 'exact' }).eq('user_id', user.id);
    if (ids?.length) query = query.in('id', ids);
    const { error, count } = await query;
    if (error) throw error;
    return count ?? ids?.length ?? 0;
  },

  async deleteObservedPlain(rows) {
    if (!rows.length) return 0;
    const user = await requireAuthenticatedUser();
    let deleted = 0;
    for (const row of rows) {
      const { error, count } = await supabase
        .from('sync_changes_plain')
        .delete({ count: 'exact' })
        .eq('user_id', user.id)
        .eq('id', row.id)
        .eq('created_at', row.createdAt)
        .eq('inserted_at', row.insertedAt);
      if (error) throw error;
      deleted += count ?? 0;
    }
    return deleted;
  },

  async deleteObservedEncrypted(rows) {
    if (!rows.length) return 0;
    const user = await requireAuthenticatedUser();
    let deleted = 0;
    for (const row of rows) {
      const { error, count } = await supabase
        .from('sync_changes_encrypted')
        .delete({ count: 'exact' })
        .eq('user_id', user.id)
        .eq('id', row.id)
        .eq('created_at', row.createdAt)
        .eq('inserted_at', row.insertedAt);
      if (error) throw error;
      deleted += count ?? 0;
    }
    return deleted;
  },
};
