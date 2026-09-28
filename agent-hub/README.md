# agent-hub (POC)

Bilgisayarında çalışan **Claude Code** ve **Codex** agent'larını Telegram'dan yönetmek,
onları birbiriyle konuşturmak ve kotayı ortak yönetmek için yerel bir hub.

- **Karar mercii = üst model** (Claude Fable, GPT üst modeli): planlar, soruları yanıtlar, sonucu review eder.
- **İmplementasyon = daha düşük model** (Sonnet, Codex'in küçük modeli): plandaki adımları uygular.
- Agent'lar vendor fark etmeden **tek bir MCP bus** üzerinden konuşur (`ask_planner`, `post_message`, `report_status`...).
- **Quota Governor**: vendor başına tek havuz; 429 / limit sinyalinde adım diğer vendor'a yönlenir.
- **Telegram**: `/task` ile görev ver, plan/adım/review bildirimleri al, Claude izin isteklerini butonla onayla.

```
Telegram ──long polling──▶ HUB (localhost)
                            ├─ Orchestrator: plan → work → review → (revise)
                            ├─ Adapters: ClaudeAdapter (Agent SDK) · CodexAdapter (codex-sdk) · Mock
                            ├─ HTTP :4777  ◀── MCP bus süreçleri (her agent kendi stdio MCP server'ını açar)
                            ├─ QuotaGovernor (vendor başına kullanım, cooldown, yönlendirme)
                            └─ Store (.hub/state.json, .hub/events.jsonl)
```

## Kurulum

```bash
cd agent-hub
npm install
cp .env.example .env            # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, HUB_REPO
cp hub.config.example.json hub.config.json   # model isimleri, planner vendor'u
```

Vendor girişleri CLI'ların kendi girişleridir: `claude` ile login (veya `ANTHROPIC_API_KEY`), `codex login`
(veya `OPENAI_API_KEY`). Codex CLI, `@openai/codex-sdk` ile birlikte gelir; ayrıca kurmak gerekmez.

`hub.config.json` içinde model katmanları:

```json
"vendors": {
  "claude": { "planner": "claude-fable-5-1", "worker": "claude-sonnet-5", "permissionMode": "acceptEdits" },
  "codex":  { "planner": "<üst codex modeli>", "worker": "<küçük codex modeli>", "sandboxMode": "workspace-write" }
}
```

Codex model adlarını `codex` içinde `/model` ile veya hesabındaki listeden al; `null` bırakırsan CLI varsayılanı kullanılır.

## Çalıştırma

```bash
npm run dev            # Telegram + konsol
npm run demo           # mock mode: kimlik bilgisi gerekmez, akışı uçtan uca gösterir
npm test               # 3 senaryo: normal akış, revizyon, rate-limit yönlendirme
HUB_NO_TELEGRAM=1 npm run dev   # sadece konsol (aynı komutlar stdin'den)
```

Telegram komutları:

```
/task <açıklama> [--planner claude|codex] [--repo /path]
/status  /agents  /tail <agentId>  /say <agentId> <mesaj>  /quota  /stop <taskId>  /repo <path>
```

## Akış

1. `/task ...` → hub planner agent'ı açar (planner vendor'unun üst modeli). Planner repoyu okur, `submit_plan` çağırır.
2. Her adım için bir worker açılır (adımın tercih ettiği vendor'un worker modeli). Quota Governor vendor sağlıksızsa yönlendirir.
3. Worker takıldığında `ask_planner` çağırır; hub planner oturumunu devam ettirir, yanıtı tool sonucu olarak worker'a döner.
   Bu yol vendor'lar arası çalışır: Codex worker → Claude planner ve tersi.
4. Worker `report_status(done)` der. Tüm adımlar bitince planner `git diff` ile review yapar, `review_verdict` verir.
   `revise` ise son worker'a notlar gider, tekrar review (en fazla `maxRevisions`).
5. Her aşama Telegram'a düşer. Değişiklikler commit edilmez, working tree'de kalır.

## Sinyaller (limit paylaşımı)

| Vendor | Kullanım | Limit sinyali |
|---|---|---|
| Claude | `result.usage`, `total_cost_usd` | `rate_limit_event` (5 saat / 7 gün %), `api_error_status=429` |
| Codex | `turn.completed.usage` | hata metninde rate limit / 429 |

Governor bir vendor'u `maxUtilizationPct` üstünde veya cooldown'da görürse yeni adımları başka vendor'a atar.
Worker turu 429 ile düşerse aynı adım diğer vendor'da bir kez daha denenir.

## Bilinen sınırlar (POC)

- Gerçek Claude/Codex adapter'ları bu ortamda kimlik bilgisi olmadığı için canlı test edilmedi; SDK tip tanımlarına ve
  MCP/Codex CLI smoke testlerine göre yazıldı. İlk gerçek çalıştırmada `/tail` ile takip et.
- Adımlar sıralı, aynı working tree'de çalışır. Paralel worker için worktree desteği yok.
- Kota sayacı tahmindir; Codex tarafında kalan kota API'si yok, sadece hata tespiti var.
- Tek kullanıcı, localhost bus, token korumalı. Dışarıya port açılmaz; Telegram long polling kullanır.
