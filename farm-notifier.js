/**
 * =============================================================================
 * Farm Clicker — Telegram Notification Bot
 * =============================================================================
 *
 * ملف مستقل تماماً — لا يحتاج تعديل في المشروع الأصلي.
 *
 * يرسل 4 أنواع من الإشعارات:
 *   1. المحاصيل جاهزة للحصاد   (كل 15 دقيقة)
 *   2. المحاصيل ستذبل قريباً   (تحذير قبل ساعة)
 *   3. المكافأة اليومية متاحة   (كل 24 ساعة)
 *   4. الطاقة اكتملت            (عند اكتمال الريجن)
 *
 * المتطلبات:
 *   Node.js >= 18  (يستخدم fetch المدمجة)
 *   حزمة واحدة فقط: npm install pg
 *
 * الإعداد:
 *   انسخ هذا الملف في أي مكان، وعيّن المتغيرات أدناه
 *   ثم شغّله كـ cron job كل 15 دقيقة:
 *   
 * =============================================================================
 */

// =============================================================================
// ⚙️  الإعداد — عيّن هذه القيم
// =============================================================================

const CONFIG = {
  /** توكن البوت من @BotFather */
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",

  /** رابط قاعدة البيانات (نفس DATABASE_URL في Railway) */
  DATABASE_URL: process.env.DATABASE_URL || "",

  /** رابط اللعبة على Vercel — يظهر في زر "افتح اللعبة" */
  APP_URL: process.env.BOT_APP_URL || "https://your-farm-clicker.vercel.app",

  /** يوزر البوت بدون @ — يظهر في رابط الزر */
  BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || "your_bot",

  // -------------------------------------------------------------------------
  // إعدادات الإشعارات — غيّرها حسب الحاجة
  // -------------------------------------------------------------------------

  /** الحد الأدنى لعدد المحاصيل الجاهزة لإرسال إشعار */
  MIN_READY_CROPS: 1,

  /** إرسال تحذير الذبول قبل كم دقيقة؟ */
  WITHER_WARN_MINUTES: 60,

  /** كم دقيقة بين كل إشعار حصاد لنفس المستخدم؟ */
  HARVEST_COOLDOWN_MINUTES: 60,

  /** كم دقيقة بين كل إشعار يومي لنفس المستخدم؟ */
  DAILY_COOLDOWN_HOURS: 23,

  /** كم دقيقة بين كل إشعار طاقة لنفس المستخدم؟ */
  ENERGY_COOLDOWN_HOURS: 3,

  /** كم دقيقة بين كل تحذير ذبول لنفس المستخدم؟ */
  WITHER_COOLDOWN_HOURS: 2,

  /** تأخير بين كل رسالة وأخرى (ملي ثانية) — لا تقل عن 50 */
  MESSAGE_DELAY_MS: 100,
};

// =============================================================================
// التحقق من الإعداد
// =============================================================================

if (!CONFIG.BOT_TOKEN) {
  console.error("[ERROR] TELEGRAM_BOT_TOKEN غير مضبوط");
  process.exit(1);
}
if (!CONFIG.DATABASE_URL) {
  console.error("[ERROR] DATABASE_URL غير مضبوط");
  process.exit(1);
}

// =============================================================================
// الاتصال بقاعدة البيانات
// =============================================================================

import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: CONFIG.DATABASE_URL });

// =============================================================================
// إنشاء جدول تتبع الإشعارات (مرة واحدة تلقائياً)
// =============================================================================

async function ensureNotifTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_notifications_log (
      id          SERIAL PRIMARY KEY,
      telegram_id TEXT        NOT NULL,
      notif_type  TEXT        NOT NULL,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bot_notif_lookup
      ON bot_notifications_log (telegram_id, notif_type, sent_at);
  `);
}

// =============================================================================
// مساعدات
// =============================================================================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * هل أرسلنا هذا النوع من الإشعارات لهذا المستخدم خلال N دقيقة؟
 */
async function wasRecentlySent(telegramId, notifType, withinMinutes) {
  const { rows } = await pool.query(
    `SELECT 1 FROM bot_notifications_log
     WHERE telegram_id = $1
       AND notif_type  = $2
       AND sent_at     > NOW() - ($3 || ' minutes')::interval
     LIMIT 1`,
    [telegramId, notifType, withinMinutes]
  );
  return rows.length > 0;
}

async function markSent(telegramId, notifType) {
  await pool.query(
    `INSERT INTO bot_notifications_log (telegram_id, notif_type)
     VALUES ($1, $2)`,
    [telegramId, notifType]
  );
}

// =============================================================================
// Telegram API
// =============================================================================

const TG_BASE = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;

/**
 * إرسال رسالة مع زر يفتح اللعبة مباشرة
 */
async function sendMessage(telegramId, text) {
  const body = {
    chat_id: telegramId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚜 افتح اللعبة",
            web_app: { url: CONFIG.APP_URL },
          },
        ],
      ],
    },
  };

  try {
    const res = await fetch(`${TG_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();

    if (!json.ok) {
      // 403 = المستخدم حظر البوت — تجاهل بصمت
      if (json.error_code !== 403 && json.error_code !== 400) {
        log(`[WARN] Telegram error للمستخدم ${telegramId}: ${json.description}`);
      }
      return false;
    }
    return true;
  } catch (err) {
    log(`[WARN] fetch error: ${err.message}`);
    return false;
  }
}

// =============================================================================
// 1. إشعار المحاصيل الجاهزة للحصاد
// =============================================================================

async function notifyHarvestReady() {
  log("🌾 فحص المحاصيل الجاهزة...");

  const { rows } = await pool.query(`
    SELECT
      u.telegram_id                    AS "telegramId",
      u.username,
      COUNT(p.id)::int                 AS ready_count,
      ARRAY_AGG(DISTINCT p.crop_type)  AS crop_types
    FROM plots p
    JOIN users u ON u.id = p.user_id
    WHERE p.state      = 'growing'
      AND p.ready_at   <= NOW()
      AND p.withered_at > NOW()
      AND u.telegram_id IS NOT NULL
      AND u.is_banned   = false
    GROUP BY u.telegram_id, u.username
    HAVING COUNT(p.id) >= $1
  `, [CONFIG.MIN_READY_CROPS]);

  log(`  → ${rows.length} مستخدم لديه محاصيل جاهزة`);
  let sent = 0;

  for (const row of rows) {
    const cooldown = CONFIG.HARVEST_COOLDOWN_MINUTES;
    if (await wasRecentlySent(row.telegramId, "harvest_ready", cooldown)) continue;

    const emojis = row.crop_types
      .map((c) => CROP_EMOJIS[c] || "🌱")
      .join(" ");

    const name = row.username ? `@${row.username}` : "مزارعنا";
    const count = row.ready_count;

    const text =
      `🌾 <b>حصادك جاهز!</b>\n\n` +
      `مرحباً ${name}،\n` +
      `لديك <b>${count} ${count === 1 ? "محصول جاهز" : "محاصيل جاهزة"}</b> للحصاد ${emojis}\n\n` +
      `⚡ احصد الآن قبل أن تذبل!`;

    const ok = await sendMessage(row.telegramId, text);
    if (ok) {
      await markSent(row.telegramId, "harvest_ready");
      sent++;
    }
    await sleep(CONFIG.MESSAGE_DELAY_MS);
  }

  log(`  ✓ أُرسل ${sent} إشعار حصاد`);
}

// =============================================================================
// 2. تحذير الذبول القريب
// =============================================================================

async function notifyWitherWarning() {
  log("⚠️  فحص المحاصيل التي ستذبل قريباً...");

  const warnMs = CONFIG.WITHER_WARN_MINUTES;

  const { rows } = await pool.query(`
    SELECT
      u.telegram_id                   AS "telegramId",
      u.username,
      COUNT(p.id)::int                AS wither_count,
      ARRAY_AGG(DISTINCT p.crop_type) AS crop_types,
      MIN(p.withered_at)              AS soonest_wither
    FROM plots p
    JOIN users u ON u.id = p.user_id
    WHERE p.state         = 'growing'
      AND p.withered_at BETWEEN NOW() AND NOW() + ($1 || ' minutes')::interval
      AND u.telegram_id IS NOT NULL
      AND u.is_banned   = false
    GROUP BY u.telegram_id, u.username
  `, [warnMs]);

  log(`  → ${rows.length} مستخدم لديه محاصيل ستذبل خلال ${warnMs} دقيقة`);
  let sent = 0;

  for (const row of rows) {
    const cooldown = CONFIG.WITHER_COOLDOWN_HOURS * 60;
    if (await wasRecentlySent(row.telegramId, "wither_warning", cooldown)) continue;

    const emojis = row.crop_types
      .map((c) => CROP_EMOJIS[c] || "🌱")
      .join(" ");

    const minutesLeft = Math.round(
      (new Date(row.soonest_wither) - Date.now()) / 60000
    );
    const name = row.username ? `@${row.username}` : "مزارعنا";

    const text =
      `🥀 <b>تحذير: محاصيلك ستذبل!</b>\n\n` +
      `مرحباً ${name}،\n` +
      `<b>${row.wither_count} محصول</b> ${emojis} سيذبل خلال <b>${minutesLeft} دقيقة</b> فقط!\n\n` +
      `🏃 سارع للحصاد الآن قبل ضياع كل شيء!`;

    const ok = await sendMessage(row.telegramId, text);
    if (ok) {
      await markSent(row.telegramId, "wither_warning");
      sent++;
    }
    await sleep(CONFIG.MESSAGE_DELAY_MS);
  }

  log(`  ✓ أُرسل ${sent} تحذير ذبول`);
}

// =============================================================================
// 3. إشعار المكافأة اليومية
// =============================================================================

async function notifyDailyReward() {
  log("🎁 فحص المكافأة اليومية...");

  const { rows } = await pool.query(`
    SELECT
      u.telegram_id       AS "telegramId",
      u.username,
      u.daily_claim_day   AS "dailyClaimDay",
      u.current_streak    AS "currentStreak"
    FROM users u
    WHERE u.telegram_id IS NOT NULL
      AND u.is_banned   = false
      AND (
        u.last_daily_claim_at IS NULL
        OR u.last_daily_claim_at < NOW() - INTERVAL '24 hours'
      )
  `);

  log(`  → ${rows.length} مستخدم لم يطالب بمكافأته اليومية`);
  let sent = 0;

  for (const row of rows) {
    const cooldown = CONFIG.DAILY_COOLDOWN_HOURS * 60;
    if (await wasRecentlySent(row.telegramId, "daily_reward", cooldown)) continue;

    const name    = row.username ? `@${row.username}` : "مزارعنا";
    const day     = (row.dailyClaimDay || 0) + 1;
    const streak  = row.currentStreak || 0;

    // المكافآت اليومية من اللعبة (مطابقة لـ DAILY_REWARDS في game-config.ts)
    const DAILY_REWARDS = [
      { coins: 50,  xp: 10  },
      { coins: 75,  xp: 15  },
      { coins: 100, xp: 20  },
      { coins: 150, xp: 30  },
      { coins: 200, xp: 40  },
      { coins: 300, xp: 60  },
      { coins: 500, xp: 100, bonus: "🎁 يوم مميز!" },
    ];

    const reward = DAILY_REWARDS[Math.min(day - 1, DAILY_REWARDS.length - 1)];
    const streakLine = streak > 1 ? `🔥 سلسلة ${streak} يوم متواصل!\n` : "";

    const text =
      `🎁 <b>مكافأتك اليومية جاهزة!</b>\n\n` +
      `مرحباً ${name}،\n` +
      `${streakLine}` +
      `اليوم <b>${day}</b> — مكافأتك:\n` +
      `🪙 <b>${reward.coins} عملة</b>  ⭐ <b>${reward.xp} XP</b>\n` +
      (reward.bonus ? `\n${reward.bonus}\n` : "") +
      `\nلا تفوّت يومك!`;

    const ok = await sendMessage(row.telegramId, text);
    if (ok) {
      await markSent(row.telegramId, "daily_reward");
      sent++;
    }
    await sleep(CONFIG.MESSAGE_DELAY_MS);
  }

  log(`  ✓ أُرسل ${sent} إشعار مكافأة يومية`);
}

// =============================================================================
// 4. إشعار اكتمال الطاقة
// =============================================================================

async function notifyEnergyFull() {
  log("⚡ فحص الطاقة المكتملة...");

  const { rows } = await pool.query(`
    SELECT
      u.telegram_id      AS "telegramId",
      u.username,
      u.energy,
      u.max_energy       AS "maxEnergy"
    FROM users u
    WHERE u.telegram_id    IS NOT NULL
      AND u.is_banned       = false
      AND u.energy          < u.max_energy
      AND u.energy_regen_at IS NOT NULL
      AND u.energy_regen_at <= NOW()
  `);

  log(`  → ${rows.length} مستخدم اكتملت طاقته`);
  let sent = 0;

  for (const row of rows) {
    const cooldown = CONFIG.ENERGY_COOLDOWN_HOURS * 60;
    if (await wasRecentlySent(row.telegramId, "energy_full", cooldown)) continue;

    const name = row.username ? `@${row.username}` : "مزارعنا";

    const text =
      `⚡ <b>طاقتك اكتملت!</b>\n\n` +
      `مرحباً ${name}،\n` +
      `طاقتك الآن جاهزة — <b>${row.maxEnergy}/${row.maxEnergy}</b> ⚡\n\n` +
      `🌱 ابدأ الزراعة الآن واجمع المزيد من العملات!`;

    const ok = await sendMessage(row.telegramId, text);
    if (ok) {
      await markSent(row.telegramId, "energy_full");
      sent++;
    }
    await sleep(CONFIG.MESSAGE_DELAY_MS);
  }

  log(`  ✓ أُرسل ${sent} إشعار طاقة`);
}

// =============================================================================
// إيموجي المحاصيل (مطابق للعبة)
// =============================================================================

const CROP_EMOJIS = {
  wheat:     "🌾",
  sunflower: "🌻",
  tomato:    "🍅",
  carrot:    "🥕",
  potato:    "🥔",
  corn:      "🌽",
};

// =============================================================================
// النقطة الرئيسية
// =============================================================================

async function main() {
  log("═══════════════════════════════════════");
  log("🚜 Farm Notifier — بدء الدورة");
  log("═══════════════════════════════════════");

  try {
    await ensureNotifTable();

    await notifyHarvestReady();
    await notifyWitherWarning();
    await notifyDailyReward();
    await notifyEnergyFull();

    log("═══════════════════════════════════════");
    log("✅ انتهت الدورة بنجاح");
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
