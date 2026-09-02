'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  MAX_KNOWLEDGE_ANSWER_CHARS,
  MAX_KNOWLEDGE_ENTRIES,
  MAX_KNOWLEDGE_QUESTION_CHARS,
  validateKnowledgeEntry,
  type KnowledgeEntry,
} from 'shared-types';
import { AppShell } from '@/components/AppShell';
import { api, ValidationError } from '@/lib/api';

/**
 * The answers customers get without anyone being asked.
 *
 * These are the only words this system sends that the owner wrote themselves and that no
 * code composed — a price sentence is assembled by `quoteMessage`, a question comes from
 * the question flow, but an answer here is sent exactly as typed. So the screen is built
 * to make that literal: the answer field is labelled with what it is, and the character
 * count is framed as what it costs to send rather than as an arbitrary limit.
 *
 * **Saving replaces the whole list**, which is why there is one Save button rather than
 * one per row. The rules that matter — no duplicate questions, no more than forty — are
 * properties of the set, so a per-row save would validate each edit against a list it
 * could not see. It also makes deleting a row and fixing the row that duplicated it a
 * single action.
 */

/** A row being edited. Ids come from the server; a new row has none until it is saved. */
interface Row extends Omit<KnowledgeEntry, 'id'> {
  id?: string;
}

const EMPTY: Row = { question: '', aliases: [], answer: '' };

function Knowledge() {
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ code: string; message: string }[]>([]);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    api
      .get<KnowledgeEntry[]>('/knowledge')
      .then((entries) => { setRows(entries); setSaved(entries); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load your answers'))
      .finally(() => setLoading(false));
  }, []);

  const patch = (index: number, change: Partial<Row>) =>
    setRows(rows.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const problems = (row: Row): string[] =>
    validateKnowledgeEntry({ question: row.question, answer: row.answer }).map((i) => i.message);

  // Compared against what the server last returned, so a row edited and edited back is
  // correctly not dirty.
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const blocking = rows.some((r) => problems(r).length > 0);
  const atCeiling = rows.length >= MAX_KNOWLEDGE_ENTRIES;

  async function save() {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      const next = await api.put<KnowledgeEntry[]>('/knowledge', {
        knowledge: rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          question: r.question.trim(),
          aliases: r.aliases,
          answer: r.answer.trim(),
          ...(r.sourceExcerpt ? { sourceExcerpt: r.sourceExcerpt } : {}),
        })),
      });
      setRows(next);
      setSaved(next);
      setJustSaved(true);
    } catch (e: unknown) {
      if (e instanceof ValidationError) setIssues(e.issues);
      else setError(e instanceof Error ? e.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row-between">
        <h1>Answers</h1>
        <span className="faint">{rows.length} of {MAX_KNOWLEDGE_ENTRIES}</span>
      </div>

      <p className="muted">
        When a caller asks one of these, we text your answer back straight away, word for
        word. Nothing rewrites it.
      </p>

      {error ? <div className="notice notice-error">{error}</div> : null}

      {issues.length > 0 ? (
        <div className="notice notice-error">
          <strong>That could not be saved.</strong>
          <ul>{issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}</ul>
        </div>
      ) : null}

      {justSaved && !dirty ? <div className="notice notice-info">Saved.</div> : null}

      {loading ? <p className="muted">Loading…</p> : null}

      {!loading && rows.length === 0 ? (
        <div className="empty">
          <p>No answers yet.</p>
          <p className="faint" style={{ margin: '0.5rem 0 1rem' }}>
            Every question a caller asks goes to a person right now. Add the ones you answer
            over and over, or read them out of a document you already have.
          </p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary" href="/settings/import">Import from a document</Link>
            <button className="btn" onClick={() => setRows([EMPTY])}>Write one</button>
          </div>
        </div>
      ) : null}

      {rows.map((row, index) => {
        const rowProblems = problems(row);
        return (
          <div className="card" key={row.id ?? `new-${index}`}>
            <div className="field">
              <label htmlFor={`q-${index}`}>What they ask</label>
              <input
                id={`q-${index}`}
                value={row.question}
                maxLength={MAX_KNOWLEDGE_QUESTION_CHARS}
                placeholder="Do you bring your own supplies?"
                onChange={(e) => patch(index, { question: e.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor={`a-${index}`}>What we send back, exactly as written</label>
              <textarea
                id={`a-${index}`}
                rows={3}
                value={row.answer}
                placeholder="Yes, we bring everything including vacuum, mop and all products."
                onChange={(e) => patch(index, { answer: e.target.value })}
              />
              <div className="faint">
                {row.answer.length}/{MAX_KNOWLEDGE_ANSWER_CHARS} characters —{' '}
                {row.answer.length > 160 ? 'two text messages' : 'one text message'}. No
                prices here: add those as a service so the figure works out correctly and
                includes GST.
              </div>
            </div>

            <div className="field">
              <label htmlFor={`al-${index}`}>Other ways they might ask it</label>
              <input
                id={`al-${index}`}
                value={row.aliases.join(', ')}
                placeholder="do you bring products, do I need to provide anything"
                onChange={(e) =>
                  patch(index, {
                    aliases: e.target.value.split(',').map((a) => a.trim()).filter(Boolean),
                  })
                }
              />
              <div className="faint">
                Separate with commas. More wordings means we recognise the question more
                often — but two answers that ask the same thing cancel each other out, so
                keep them distinct.
              </div>
            </div>

            {row.sourceExcerpt ? (
              <div className="faint">From your document: <q>{row.sourceExcerpt}</q></div>
            ) : null}

            {rowProblems.length > 0 ? (
              <div className="notice notice-warn">
                <ul>{rowProblems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            ) : null}

            <div className="btn-row" style={{ marginTop: '0.7rem' }}>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => setRows(rows.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}

      {!loading && rows.length > 0 ? (
        <div className="btn-row">
          <button
            className="btn btn-primary"
            disabled={busy || blocking || !dirty}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn"
            disabled={busy || atCeiling}
            onClick={() => { setRows([...rows, EMPTY]); setJustSaved(false); }}
          >
            Add another
          </button>
          {dirty ? (
            <button
              className="btn btn-quiet"
              disabled={busy}
              onClick={() => { setRows(saved); setIssues([]); }}
            >
              Discard changes
            </button>
          ) : null}
        </div>
      ) : null}

      {atCeiling ? (
        <p className="faint">
          That is the maximum. Past {MAX_KNOWLEDGE_ENTRIES} answers, recognising which
          question was asked gets less certain and more of them end up going to you instead.
        </p>
      ) : null}
    </>
  );
}

export default function KnowledgePage() {
  return (
    <AppShell>
      <Knowledge />
    </AppShell>
  );
}
