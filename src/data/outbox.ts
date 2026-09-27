/**
 * File d'enregistrement en ligne (comptes Supabase) : aucune modification n'est perdue.
 *
 * - Chaque modification est d'abord mise en file (conservée dans le navigateur), puis envoyée ;
 * - échec réseau ou service indisponible → la modification reste en file et repart automatiquement
 *   (retour du réseau, retour sur l'onglet, toutes les 30 s) ;
 * - dossiers : seuls les champs modifiés sont envoyés (fusion côté serveur) → ce qu'un autre appareil
 *   ou la candidature automatique a écrit entre-temps est préservé ;
 * - profil : enregistrement conditionnel (version) ; en cas de conflit, les champs modifiés ici sont
 *   réappliqués sur la version la plus récente (aucun écrasement silencieux).
 *
 * État exposé : « saved » (tout est en ligne), « pending » (en cours ou en attente), « error » (refus définitif).
 */

export type SyncState = 'saved' | 'pending' | 'error';

export type Op =
  | { kind: 'saveApp'; id: string; app: any }
  | { kind: 'patchApp'; id: string; patch: Record<string, any> }
  | { kind: 'deleteApp'; id: string }
  | { kind: 'saveProfile'; profile: any; baseVersion: number | null; changed: string[] };

export interface OutboxApi {
  saveApplication(uid: string, app: any): Promise<void>;
  patchApplication(uid: string, id: string, patch: Record<string, any>): Promise<{ found: boolean }>;
  deleteApplication(uid: string, id: string): Promise<void>;
  saveProfile(uid: string, profile: any, expected: number | null): Promise<{ ok: boolean; version: number; data: any }>;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

interface Entry { op: Op; attempts: number; lastError?: string }

/** Erreur définitive (refusée par le serveur) : inutile de réessayer. */
const isPermanent = (e: any) => {
  const status = Number(e?.status || e?.code);
  return (status >= 400 && status < 500 && status !== 408 && status !== 429) || /^(22|23|42)/.test(String(e?.code || ''));
};

export class Outbox {
  private queue: Entry[] = [];
  /** Modification en cours d'envoi : jamais fusionnée avec une nouvelle (on ne sait pas ce qui est parti). */
  private inFlight: Entry | null = null;
  private running: Promise<void> | null = null;
  private listeners = new Set<(s: SyncState, detail?: string) => void>();
  private failed = false;
  private failure?: string;
  /** Dernière version connue du profil en ligne et son contenu (base des fusions en cas de conflit). */
  profileVersion: number | null = null;
  onProfileMerged?: (profile: any) => void;

  constructor(private uid: string, private api: OutboxApi, private storage: StorageLike | null) {
    try {
      const raw = storage?.getItem(this.key());
      if (raw) this.queue = JSON.parse(raw);
    } catch {
      this.queue = [];
    }
  }

  private key() { return `kareer_outbox_${this.uid}`; }
  private persist() {
    try { this.storage?.setItem(this.key(), JSON.stringify(this.queue)); } catch { /* stockage plein : la file reste en mémoire */ }
  }

  get state(): SyncState { return this.failed ? 'error' : this.queue.length ? 'pending' : 'saved'; }
  get size() { return this.queue.length; }
  get lastError() { return this.failure; }
  pendingOps(): Op[] { return this.queue.map((e) => e.op); }

  subscribe(fn: (s: SyncState, detail?: string) => void) {
    this.listeners.add(fn);
    fn(this.state, this.failure);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { for (const fn of this.listeners) fn(this.state, this.failure); }

  enqueue(op: Op) {
    // Fusion des modifications successives d'un même dossier (une seule requête)
    const last = this.queue[this.queue.length - 1];
    if (op.kind === 'patchApp' && last && last !== this.inFlight && last.op.kind === 'patchApp' && last.op.id === op.id) {
      last.op.patch = { ...last.op.patch, ...op.patch };
    } else if (op.kind === 'saveProfile') {
      // Un seul enregistrement de profil en attente : le plus récent, avec l'union des champs modifiés
      const prev = this.queue.find((e) => e.op.kind === 'saveProfile' && e !== this.inFlight);
      if (prev && prev.op.kind === 'saveProfile') {
        prev.op = { ...op, changed: Array.from(new Set([...prev.op.changed, ...op.changed])), baseVersion: prev.op.baseVersion };
      } else this.queue.push({ op, attempts: 0 });
    } else {
      this.queue.push({ op, attempts: 0 });
    }
    this.persist();
    this.emit();
    return this.flush();
  }

  /** Envoie les modifications en file, dans l'ordre. Sans effet si un envoi est déjà en cours. */
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (this.queue.length) {
          const entry = this.queue[0];
          try {
            this.inFlight = entry;
            await this.apply(entry.op);
            this.queue.shift();
            this.failed = false;
            this.failure = undefined;
            this.persist();
            this.emit();
          } catch (e: any) {
            entry.attempts++;
            entry.lastError = String(e?.message || e).slice(0, 200);
            if (isPermanent(e)) {
              // Refus définitif : la modification est écartée pour ne pas bloquer les suivantes, et signalée
              this.queue.shift();
              this.failed = true;
              this.failure = 'Une modification a été refusée par le serveur : rechargez la page pour retrouver la dernière version enregistrée.';
            }
            this.persist();
            this.emit();
            if (!isPermanent(e)) break; // réseau ou service indisponible : nouvel essai plus tard
          } finally {
            this.inFlight = null;
          }
        }
      } finally {
        this.inFlight = null;
        this.running = null;
      }
    })();
    return this.running;
  }

  private async apply(op: Op) {
    switch (op.kind) {
      case 'saveApp':
        return this.api.saveApplication(this.uid, op.app);
      case 'deleteApp':
        return this.api.deleteApplication(this.uid, op.id);
      case 'patchApp': {
        const r = await this.api.patchApplication(this.uid, op.id, op.patch);
        // Dossier absent en ligne (création encore en file ou supprimé ailleurs) : rien à fusionner
        if (!r.found) return;
        return;
      }
      case 'saveProfile': {
        const expected = op.baseVersion ?? this.profileVersion;
        let r = await this.api.saveProfile(this.uid, op.profile, expected);
        if (!r.ok) {
          // Modifié sur un autre appareil : nos champs modifiés sont réappliqués sur la version la plus récente
          const merged = { ...r.data };
          for (const k of op.changed) merged[k] = op.profile[k];
          r = await this.api.saveProfile(this.uid, merged, r.version);
          if (!r.ok) throw Object.assign(new Error('Conflit persistant sur le profil'), { status: 503 });
          this.onProfileMerged?.(r.data);
        }
        this.profileVersion = r.version;
        return;
      }
    }
  }
}

/**
 * Dossiers chargés depuis le serveur + modifications encore en file : l'écran ne « revient » jamais en arrière
 * pendant qu'un enregistrement est en attente.
 */
export function overlayPending(apps: any[], box: Outbox | null): any[] {
  if (!box) return apps;
  let out = [...apps];
  for (const op of box.pendingOps()) {
    if (op.kind === 'saveApp') out = [op.app, ...out.filter((a) => a.id !== op.id)];
    else if (op.kind === 'patchApp') out = out.map((a) => (a.id === op.id ? { ...a, ...op.patch } : a));
    else if (op.kind === 'deleteApp') out = out.filter((a) => a.id !== op.id);
  }
  return out;
}

/** Champs de premier niveau différents entre deux profils. */
export function changedKeys(before: any, after: any): string[] {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}
