import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignAndSendTransaction, useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, getBase58Decoder } from "@solana/kit";
import { Buffer } from "buffer";
import "./styles.css";

// Privy's Solana signing uses Node's Buffer; browsers don't have it
(globalThis as any).Buffer ??= Buffer;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = import.meta.env.VITE_SOLANA_RPC_URL as string;

// ---------- utils ----------
let getToken: () => Promise<string | null> = async () => null;
async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const r = await fetch("/api" + path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j;
}

// "1.5" + 6 decimals -> "1500000", exact (no floats)
function toRaw(s: string, dec: number): string | null {
  const m = s.trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const frac = (m[2] ?? "").slice(0, dec).padEnd(dec, "0");
  const raw = ((m[1] || "0") + frac).replace(/^0+/, "");
  return raw || null;
}

const num = (n: number | string, d = 6) => Number(n).toLocaleString(undefined, { maximumSignificantDigits: d });
const usd = (n: number | string) => {
  const v = Number(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 2 });
};
const short = (a: string) => a.slice(0, 4) + "…" + a.slice(-4);
const ago = (ts: string) => {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(ts).toLocaleDateString();
};

function useHash() {
  const [h, set] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => set(location.hash.slice(1) || "/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

function usePoll<T>(path: string | null, ms = 0): [T | undefined, () => void, string] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const run = () => api<T>(path).then((d) => { if (live) { setData(d); setErr(""); } }, (e) => live && setErr(e.message));
    run();
    const t = ms ? setInterval(run, ms) : undefined;
    return () => { live = false; clearInterval(t); };
  }, [path, ms, n]);
  return [data, () => setN((x) => x + 1), err];
}

type Me = { id: string; username: string; wallet: string };

// sign + send a base64 tx from the API with the user's Privy wallet
function useSend(me?: Me | null) {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  return async (b64: string) => {
    const wallet = wallets.find((w) => w.address === me?.wallet);
    if (!wallet) throw new Error("Wallet isn't ready yet. Try again in a moment.");
    const { signature } = await signAndSendTransaction({
      transaction: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
      wallet,
      chain: "solana:mainnet",
    });
    return getBase58Decoder().decode(signature);
  };
}

// ---------- app ----------
function App() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  getToken = authenticated ? getAccessToken : async () => null;
  const route = useHash();
  const [me, reloadMe, meErr] = usePoll<Me | null>(ready && authenticated ? "/me" : null);

  if (!ready) return <p className="center muted">Loading…</p>;
  if (!authenticated)
    return (
      <main className="landing">
        <h1>fomo</h1>
        <p>Trade Solana tokens with USDC and see what the people you follow are buying.</p>
        <button className="primary" onClick={login}>Sign in</button>
      </main>
    );
  if (me === undefined)
    return meErr ? (
      <main className="landing">
        <h1>Can't load your account</h1>
        <p className="error" role="alert">{meErr}</p>
        <div className="row">
          <button className="primary" onClick={reloadMe}>Try again</button>
          <button className="quiet" onClick={logout}>Sign out</button>
        </div>
      </main>
    ) : <p className="center muted">Loading your account…</p>;
  if (me === null) return <Signup onDone={reloadMe} />;

  const [, page, arg] = route.split("/");
  return (
    <>
      <header>
        <a className="brand" href="#/">fomo</a>
        <nav>
          <a href="#/" aria-current={!page}>Markets</a>
          <a href={`#/u/${me.username}`} aria-current={page === "u" && arg === me.username}>Portfolio</a>
          <a href="#/alerts" aria-current={page === "alerts"}>Alerts</a>
        </nav>
        <Deposit wallet={me.wallet} />
        <button className="quiet" onClick={logout}>Sign out @{me.username}</button>
      </header>
      {page === "u" ? <Profile key={arg} username={arg} me={me} />
        : page === "alerts" ? <Alerts />
        : <Markets me={me} />}
    </>
  );
}

function Signup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState(() => "fomo_" + Math.floor(1000 + Math.random() * 9000));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { createWallet } = useCreateWallet();
  const wallet = wallets.find((w) => w.standardWallet.name === "Privy") ?? wallets[0];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      if (!wallet) { await createWallet(); return; } // re-renders with the new wallet; user clicks again
      // proves to the server that this wallet is ours (no Privy server secret needed)
      const { signature } = await signMessage({
        message: new TextEncoder().encode(`Sign in to fomo as ${user!.id}`),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      const sig = btoa(String.fromCharCode(...signature));
      await api("/me", { method: "POST", body: JSON.stringify({ username: name, wallet: wallet.address, signature: sig }) });
      onDone();
    } catch (e: any) {
      setErr(e.message === "already taken" ? `@${name} is taken. Try another.` : e.message);
    } finally { setBusy(false); }
  };
  return (
    <main className="landing">
      <h1>Pick a username</h1>
      <p>Everyone sees your trades under this name.</p>
      <form onSubmit={submit} className="row">
        <label className="field">
          <span>@</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern="[a-z0-9_]{3,20}" required autoFocus aria-label="Username" />
        </label>
        <button className="primary" disabled={busy || !walletsReady}>
          {busy ? "Creating…" : !walletsReady ? "Loading wallet…" : wallet ? "Create account" : "Set up wallet"}
        </button>
      </form>
      <p className="hint">3–20 characters: a–z, 0–9 and underscores.</p>
      {wallet && <p className="hint">Your deposit address: {wallet.address}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </main>
  );
}

function Deposit({ wallet }: { wallet: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="deposit" title="Send USDC (Solana) to this address" onClick={() => {
      navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>
      {copied ? "Address copied" : <>Deposit USDC to <b>{short(wallet)}</b></>}
    </button>
  );
}

// ---------- markets ----------
type Token = {
  id: string; symbol: string; name: string; icon?: string; decimals: number; usdPrice?: number; stats24h?: { priceChange?: number };
  liquidity?: number; verified?: boolean; freezable?: boolean; mintable?: boolean;
};

// Plain-language risk notes shown before trading a token
function risks(t: Token): string[] {
  const r: string[] = [];
  if (!t.verified) r.push("Not verified by Jupiter. Anyone can create a token with any name.");
  if (t.freezable) r.push("The issuer can freeze this token in your wallet, so you might not be able to sell.");
  if (t.mintable) r.push("The issuer can mint more of this token, which can dilute its price.");
  if ((t.liquidity ?? 0) < 50_000) r.push("Low liquidity. Larger trades may fail or move the price a lot.");
  return r;
}

function Markets({ me }: { me: Me }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const [tokens, , err] = usePoll<Token[]>(query ? `/tokens?q=${encodeURIComponent(query)}` : "/tokens", query ? 0 : 30_000);
  const list = (tokens ?? []).filter((t) => t.id !== USDC);
  const [sel, setSel] = useState<string>();
  const token = list.find((t) => t.id === sel) ?? list[0];

  return (
    <main className="markets">
      <aside className="tokens">
        <input type="search" placeholder="Search token or paste mint" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tokens" />
        {err && <p className="error">{err}</p>}
        <ul>
          {list.map((t) => {
            const ch = t.stats24h?.priceChange ?? 0;
            return (
              <li key={t.id}>
                <button aria-pressed={t.id === token?.id} onClick={() => setSel(t.id)}>
                  {t.icon ? <img src={t.icon} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="dot" />}
                  <span className="sym">{t.symbol}{!t.verified && <span className="unverified" title="Not verified by Jupiter"> ⚠</span>}</span>
                  <span className="px">{t.usdPrice != null ? usd(t.usdPrice) : "—"}</span>
                  <span className={ch >= 0 ? "up" : "down"}>{ch >= 0 ? "+" : ""}{ch.toFixed(1)}%</span>
                </button>
              </li>
            );
          })}
          {tokens && !list.length && <li className="muted pad">No tokens match “{query}”.</li>}
        </ul>
      </aside>
      {token ? <TokenView key={token.id} token={token} me={me} /> : <section className="muted pad">Loading markets…</section>}
    </main>
  );
}

function TokenView({ token, me }: { token: Token; me: Me }) {
  const [tf, setTf] = useState<"minute" | "hour" | "day">("hour");
  const [candles, , err] = usePoll<number[][]>(`/candles/${token.id}?tf=${tf}`, 60_000);
  const ch = token.stats24h?.priceChange ?? 0;
  return (
    <section className="token">
      <div className="head">
        <h2>{token.symbol} <span className="muted">{token.name}</span></h2>
        <p className="price">{token.usdPrice != null ? usd(token.usdPrice) : "—"}</p>
        <p className={ch >= 0 ? "up" : "down"}>{ch >= 0 ? "+" : ""}{ch.toFixed(2)}% today</p>
      </div>
      <div className="tf" role="group" aria-label="Chart timeframe">
        {(["minute", "hour", "day"] as const).map((t) => (
          <button key={t} aria-pressed={tf === t} onClick={() => setTf(t)}>{{ minute: "1m", hour: "1h", day: "1d" }[t]}</button>
        ))}
      </div>
      {candles || !err ? <Chart candles={candles} /> : <div className="chart muted">Chart unavailable right now. {err}</div>}
      {candles && err && <p className="hint">Showing the last chart we loaded. Live data is temporarily unavailable.</p>}
      <Ticket token={token} me={me} />
    </section>
  );
}

function Chart({ candles }: { candles?: number[][] }) {
  if (!candles) return <div className="chart muted">Loading chart…</div>;
  const closes = [...candles].reverse().map((c) => c[4]);
  if (closes.length < 2) return <div className="chart muted">Not enough trading history yet.</div>;
  const [lo, hi] = [Math.min(...closes), Math.max(...closes)];
  const W = 800, H = 260;
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * W},${H - ((c - lo) / (hi - lo || 1)) * (H - 8) - 4}`).join(" ");
  const up = closes.at(-1)! >= closes[0];
  return (
    <svg className={`chart ${up ? "up" : "down"}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Price ${up ? "up" : "down"} over this range`}>
      <polygon points={`0,${H} ${pts} ${W},${H}`} className="area" />
      <polyline points={pts} className="line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Ticket({ token, me }: { token: Token; me: Me }) {
  const send = useSend(me);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  const unit = side === "buy" ? "USDC" : token.symbol;
  const warn = risks(token);
  const est = Number(amt) && token.usdPrice ? (side === "buy" ? `≈ ${num(Number(amt) / token.usdPrice)} ${token.symbol}` : `≈ ${usd(Number(amt) * token.usdPrice)}`) : "";

  const trade = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = toRaw(amt, side === "buy" ? 6 : token.decimals);
    if (!raw) return setMsg({ err: "Enter an amount above zero." });
    setBusy(true); setMsg({});
    try {
      const { tx } = await api("/swap", { method: "POST", body: JSON.stringify({ side, mint: token.id, amount: raw }) });
      const sig = await send(tx);
      setMsg({ ok: sig }); setAmt("");
    } catch (e: any) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  return (
    <form className={`ticket ${side}`} onSubmit={trade}>
      <div className="tf" role="group" aria-label="Side">
        <button type="button" aria-pressed={side === "buy"} onClick={() => setSide("buy")}>Buy</button>
        <button type="button" aria-pressed={side === "sell"} onClick={() => setSide("sell")}>Sell</button>
      </div>
      <label className="field">
        <input inputMode="decimal" placeholder="0.00" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label={`Amount in ${unit}`} />
        <span>{unit}</span>
      </label>
      <p className="hint">{est || " "}</p>
      {side === "buy" && warn.length > 0 && <ul className="risks">{warn.map((w) => <li key={w}>{w}</li>)}</ul>}
      <button className="primary" disabled={busy}>
        {busy ? "Confirm in wallet…" : `${side === "buy" ? "Buy" : "Sell"} ${token.symbol}${side === "buy" && !token.verified ? " anyway" : ""}`}
      </button>
      <p className="hint">Includes a 0.1% platform fee. Your wallet needs a little SOL for network fees.</p>
      {msg.ok && <p className="ok" role="status">{side === "buy" ? "Bought" : "Sold"}. <a href={`https://solscan.io/tx/${msg.ok}`} target="_blank" rel="noreferrer">View transaction</a></p>}
      {msg.err && <p className="error" role="alert">{msg.err}</p>}
    </form>
  );
}

// ---------- profile / portfolio ----------
type Trade = { sig: string; mint: string; kind: string; amount: string; usdc: string; ts: string; symbol?: string; username?: string };
type ProfileData = {
  user: Omit<Me, "id">; cash: number; followers: string[]; following: string[]; trades: Trade[];
  holdings: { mint: string; symbol?: string; icon?: string; decimals?: number; amount: string; value: number; pnl: number }[];
};

function Profile({ username, me }: { username: string; me: Me }) {
  const [p, reload, err] = usePoll<ProfileData>(`/u/${encodeURIComponent(username)}`, 15_000);
  const [busy, setBusy] = useState(false);
  if (err) return <main className="pad error">{err}</main>;
  if (!p) return <main className="pad muted">Loading…</main>;
  const mine = p.user.username === me.username;
  const following = p.followers.includes(me.username);
  const total = p.cash + p.holdings.reduce((s, h) => s + h.value, 0);

  const toggle = async () => {
    setBusy(true);
    await api(`/follow/${username}`, { method: following ? "DELETE" : "POST" }).catch(() => {});
    reload(); setBusy(false);
  };

  return (
    <main className="profile">
      <div className="head">
        <h2>@{p.user.username}</h2>
        <p className="price">{usd(total)}</p>
        <div className="stats">
          <People label="followers" names={p.followers} />
          <People label="following" names={p.following} />
          <span>{usd(p.cash)} in USDC</span>
        </div>
        {!mine && <button className={following ? "quiet" : "primary"} onClick={toggle} disabled={busy}>{following ? "Unfollow" : "Follow"}</button>}
      </div>

      <h3>Holdings</h3>
      {p.holdings.filter((h) => Number(h.amount) > 0).length ? (
        <table>
          <thead><tr><th>Token</th><th>Amount</th><th>Value</th><th>P&amp;L</th></tr></thead>
          <tbody>
            {p.holdings.filter((h) => Number(h.amount) > 0).map((h) => (
              <tr key={h.mint}>
                <td>{h.symbol ?? short(h.mint)}</td><td>{num(h.amount)}</td><td>{usd(h.value)}</td>
                <td className={h.pnl >= 0 ? "up" : "down"}>{h.pnl >= 0 ? "+" : ""}{usd(h.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">{mine ? "No tokens yet. Deposit USDC, then buy from Markets." : "No open positions."}</p>}

      {mine && <Withdraw me={me} p={p} onDone={reload} />}

      <h3>Activity</h3>
      <TradeList trades={p.trades} empty={mine ? "Your trades show up here a few seconds after they land on-chain." : "No trades yet."} />
    </main>
  );
}

function People({ label, names }: { label: string; names: string[] }) {
  return (
    <details className="people">
      <summary>{names.length} {label}</summary>
      <ul>{names.map((n) => <li key={n}><a href={`#/u/${n}`}>@{n}</a></li>)}</ul>
    </details>
  );
}

function Withdraw({ me, p, onDone }: { me: Me; p: ProfileData; onDone: () => void }) {
  const send = useSend(me);
  const opts = [{ mint: USDC, symbol: "USDC", decimals: 6, amount: String(p.cash) }, ...p.holdings.filter((h) => Number(h.amount) > 0)];
  const [mint, setMint] = useState(USDC);
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  const o = opts.find((x) => x.mint === mint) ?? opts[0];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (o.decimals == null) return setMsg({ err: "Couldn't load this token's details. Try again shortly." });
    const raw = toRaw(amt, o.decimals);
    if (!raw) return setMsg({ err: "Enter an amount above zero." });
    setBusy(true); setMsg({});
    try {
      const { tx } = await api("/withdraw", { method: "POST", body: JSON.stringify({ mint, amount: raw, to: to.trim() }) });
      setMsg({ ok: await send(tx) }); setAmt(""); onDone();
    } catch (e: any) { setMsg({ err: e.message }); }
    setBusy(false);
  };

  return (
    <details className="withdraw">
      <summary>Withdraw</summary>
      <form onSubmit={submit}>
        <label className="field"><span>Token</span>
          <select value={mint} onChange={(e) => setMint(e.target.value)}>
            {opts.map((x) => <option key={x.mint} value={x.mint}>{x.symbol ?? short(x.mint)} ({num(x.amount)})</option>)}
          </select>
        </label>
        <label className="field"><span>Amount</span><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
          <button type="button" className="quiet" onClick={() => setAmt(o.amount)}>Max</button></label>
        <label className="field"><span>To</span><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Solana address" required /></label>
        <button className="primary" disabled={busy}>{busy ? "Confirm in wallet…" : "Withdraw"}</button>
        {msg.ok && <p className="ok" role="status">Withdrawn. <a href={`https://solscan.io/tx/${msg.ok}`} target="_blank" rel="noreferrer">View transaction</a></p>}
        {msg.err && <p className="error" role="alert">{msg.err}</p>}
      </form>
    </details>
  );
}

function TradeList({ trades, empty }: { trades: Trade[]; empty: string }) {
  if (!trades.length) return <p className="muted">{empty}</p>;
  const verb: Record<string, string> = { buy: "bought", sell: "sold", deposit: "deposited", withdraw: "withdrew" };
  return (
    <ul className="feed">
      {trades.map((t) => (
        <li key={t.sig + t.mint}>
          <span className={`kind ${t.kind}`}>
            {t.username && <a href={`#/u/${t.username}`}>@{t.username} </a>}
            {verb[t.kind]} {num(Math.abs(Number(t.amount)))} {t.symbol ?? short(t.mint)}
            {Number(t.usdc) !== 0 && <> for {usd(Math.abs(Number(t.usdc)))}</>}
          </span>
          <a className="muted" href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noreferrer">{ago(t.ts)}</a>
        </li>
      ))}
    </ul>
  );
}

function Alerts() {
  const [trades, , err] = usePoll<Trade[]>("/alerts", 10_000);
  return (
    <main className="profile">
      <h2>Alerts</h2>
      <p className="muted">Buys and sells from people you follow. Updates every 10 seconds.</p>
      {err && <p className="error">{err}</p>}
      {trades && <TradeList trades={trades} empty="Nothing yet. Follow traders from their profile to see their moves here." />}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID as string}
      config={{
        appearance: { walletChainType: "solana-only" },
        embeddedWallets: { solana: { createOnLogin: "all-users" } },
        solana: {
          rpcs: {
            "solana:mainnet": {
              rpc: createSolanaRpc(RPC),
              rpcSubscriptions: createSolanaRpcSubscriptions(RPC.replace(/^http/, "ws")),
            },
          },
        },
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
);
