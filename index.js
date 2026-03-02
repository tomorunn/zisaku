const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();

// --- ミドルウェア ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- MongoDB 接続設定 ---
const uri = process.env.MONGO_URI;
if (!uri) {
    console.error("MONGO_URI が .env に設定されていません。");
    process.exit(1);
}
const client = new MongoClient(uri, { useUnifiedTopology: true });
let db;

async function connectDB() {
    if (db) return db;
    await client.connect();
    db = client.db('study_app');
    await db.collection('users').createIndex({ username: 1 }, { unique: true }).catch(()=>{});
    return db;
}

app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) {
    console.error("=== DB接続エラーの詳細 ===");
    console.error(err);
    res.status(503).send("DB接続エラー (詳細はサーバーコンソールを確認してください)");
  }
});

// --- データ操作関数（すべて復元） ---
const loadSets = async () => {
    const col = db.collection('problem_sets');
    return await col.find({}).toArray();
};

const saveSet = async (set) => {
    const col = db.collection('problem_sets');
    if (set._id) {
        const idStr = typeof set._id === 'string' ? set._id : String(set._id);
        const oid = ObjectId.isValid(idStr) ? new ObjectId(idStr) : null;
        const { _id, ...updateData } = set;
        if (oid) {
            await col.updateOne({ _id: oid }, { $set: updateData });
        } else {
            await col.insertOne(updateData);
        }
    } else {
        await col.insertOne(set);
    }
};

const loadUsers = async () => {
    return await db.collection('users').find({}).toArray();
};

function isValidObjectIdString(s) {
    try {
        return ObjectId.isValid(String(s));
    } catch {
        return false;
    }
}

// --- HTML生成（共通パーツ） ---
const generatePage = (user, content) => `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Study Gamification</title>
        <link rel="stylesheet" href="/style.css">
    </head>
    <body>
        <nav>
            <div>
                <a href="/">HOME</a>
                <a href="/admin">解答設定</a>
            </div>
            <div>
                ${user ? `<span>Hi, <strong>${escapeHtml(user.username)}</strong></span> <a href="/logout" style="margin-left:15px; font-size:0.8rem; color:#888;">Logout</a>` : '<a href="/login">Login</a>'}
            </div>
        </nav>
        <main>${content}</main>
    </body>
    </html>
`;

function escapeHtml(s = '') {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}

// --- 認証 ---
app.get('/login', (req, res) => {
    const content = `
        <div class="set-card" style="max-width:400px; margin: 40px auto; text-align:center;">
            <h2>ログイン</h2>
            <form method="POST" action="/login">
                <input name="username" placeholder="ユーザー名を入力" required autofocus>
                <button type="submit" style="width:100%; margin-top:10px;">学習を開始する</button>
            </form>
        </div>
    `;
    res.send(generatePage(null, content));
});

app.post('/login', async (req, res) => {
    const username = (req.body.username || '').trim();
    if (!username) return res.redirect('/login');
    const col = db.collection('users');
    await col.updateOne({ username }, { $setOnInsert: { username, submissions: [] } }, { upsert: true });
    res.cookie('username', username, { httpOnly: true });
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    res.clearCookie('username');
    res.redirect('/login');
});

// --- ルート設定 ---

// 1. 問題集一覧
app.get('/', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    let user = await db.collection('users').findOne({ username });
    if (!user) {
        await db.collection('users').updateOne({ username }, { $setOnInsert: { username, submissions: [] } }, { upsert: true });
        user = await db.collection('users').findOne({ username });
    }

    let content = `<h2>問題集一覧</h2>`;
    sets.forEach((set, idx) => {
        const setIdStr = String(set._id);
        const solvedCount = (set.problems || []).filter(p => 
            (user.submissions || []).find(s => s.setId === setIdStr && s.probId == p.id && s.result === 'CA')
        ).length;
        const total = set.problems ? set.problems.length : 0;
        const progress = total > 0 ? (solvedCount / total) * 100 : 0;

        content += `
            <div class="set-card">
                <h3 style="margin-top:0;">${escapeHtml(set.title || `問題集 ${idx}`)}</h3>
                <div class="progress-container">
                    <div class="progress-bar"><div class="progress-fill" style="width: ${Math.round(progress)}%"></div></div>
                    <p style="font-size: 0.9rem; margin: 5px 0;">進捗: <strong>${solvedCount}</strong> / ${total} (${Math.round(progress)}%)</p>
                </div>
                <a href="/set/${idx}"><button>問題を解く</button></a>
            </div>
        `;
    });
    res.send(generatePage(user, content));
});

// 2. 問題選択ページ
app.get('/set/:index', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    const user = await db.collection('users').findOne({ username });

    let content = `<h2>${escapeHtml(set.title)}</h2><div class="problem-grid">`;
    (set.problems || []).forEach(prob => {
        const displayLabel = String(prob.label || prob.id || '');
        const sub = (user && user.submissions || []).find(s => s.setId === String(set._id) && s.probId == prob.id);
        const resultClass = sub ? (sub.result === 'CA' ? 'ca' : 'wa') : '';

        content += `
            <div class="status-box ${resultClass}" onclick="location.href='/submit/${idx}/${encodeURIComponent(prob.id)}'" title="${escapeHtml(displayLabel)}">
                ${escapeHtml(displayLabel)}
            </div>
        `;
    });

    content += `</div><p style="text-align:center;"><a href="/">← 一覧に戻る</a></p>`;
    res.send(generatePage(user, content));
});

// 3. 判定ロジック
app.get('/submit/:setIdx/:probId', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const idx = Number(req.params.setIdx);
    const set = sets[idx];
    const problem = (set.problems || []).find(p => String(p.id) === String(req.params.probId));
    if (!problem) return res.status(404).send(generatePage(null, `<p>問題が見つかりません。</p>`));

    res.send(generatePage({username}, `
        <div class="set-card" style="text-align:center;">
            <h3>${escapeHtml(set.title)}</h3>
            <p style="font-size:1.5rem; font-weight:bold;">${escapeHtml(String(problem.label || problem.id))}</p>
            <form method="POST">
                <input type="text" name="answer" placeholder="答えを入力" autofocus required style="text-align:center; font-size:1.2rem;">
                <button type="submit" style="width:100%; height:50px; font-size:1.2rem; margin-top:10px;">判定する</button>
            </form>
            <p style="margin-top:20px;"><a href="/set/${idx}">問題を解き直す</a></p>
        </div>
    `));
});

app.post('/submit/:setIdx/:probId', async (req, res) => {
  try {
    const username = req.cookies.username;
    const { setIdx, probId } = req.params;
    const rawAnswer = (req.body.answer || '').toString();
    const sets = await loadSets();
    const idx = Number(setIdx);
    const set = sets[idx];
    const problem = (set.problems || []).find(p => String(p.id) === String(probId));

    const isNumericString = s => /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(String(s).trim());
    const numericEqual = (aStr, bStr) => {
      const a = Number(aStr), b = Number(bStr);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return Math.abs(a - b) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
    };

    let isCorrect = false;
    const expected = problem.correctAnswer || "";
    if (isNumericString(expected) && isNumericString(rawAnswer)) {
      isCorrect = numericEqual(expected, rawAnswer);
    } else {
      isCorrect = expected.toString().trim().toLowerCase() === rawAnswer.toString().trim().toLowerCase();
    }

    const result = isCorrect ? 'CA' : 'WA';
    const setIdStr = String(set._id);
    await db.collection('users').updateOne({ username }, { $pull: { submissions: { setId: setIdStr, probId: String(probId) } } });
    await db.collection('users').updateOne({ username }, { $push: { submissions: { setId: setIdStr, probId: String(probId), result, answer: String(rawAnswer), date: new Date() } } });

    const color = isCorrect ? 'var(--success)' : 'var(--error)';
    res.send(generatePage({username}, `
        <div class="set-card" style="text-align: center; padding: 3rem 1rem;">
            <div class="result-display" style="color: ${color}">${result}</div>
            <p style="font-size:1.2rem;">あなたの回答: <strong>${escapeHtml(rawAnswer)}</strong></p>
            <p style="color:#888;">正解は記録されました。</p>
            <div style="margin-top:30px;">
                <a href="/set/${idx}"><button>問題一覧に戻る</button></a>
            </div>
        </div>
    `));
  } catch (err) {
    res.status(500).send("エラーが発生しました。");
  }
});

// --- 管理画面（全機能復元） ---
app.get('/admin', async (req, res) => {
    const sets = await loadSets();
    let content = `
        <h2>管理者設定</h2>
        <div class="set-card">
            <h3>新規問題集の追加</h3>
            <form action="/admin/add-set" method="POST">
                <input type="text" name="title" placeholder="問題集の名前 (例: 数学チャート)" required>
                <input type="number" name="count" placeholder="初期の問題数" min="1" required>
                <button type="submit">作成</button>
            </form>
        </div>
        <hr>
        <h3>作成済みの問題集</h3>
    `;
    sets.forEach((set, idx) => {
        content += `<div class="admin-row">
            <strong>${escapeHtml(set.title || `問題集 ${idx}`)}</strong> 
            <a href="/admin/edit/${idx}" style="float:right;">正解を編集 →</a>
        </div>`;
    });
    res.send(generatePage(null, content));
});

app.post('/admin/add-set', async (req, res) => {
    const title = (req.body.title || '').toString().trim() || '無題';
    const count = Math.max(1, Number(req.body.count) || 0);
    const problems = [];
    for (let i = 1; i <= count; i++) {
        problems.push({ id: i.toString(), label: `問${i}`, correctAnswer: "" });
    }
    await saveSet({ title, problems });
    res.redirect('/admin');
});

// 問題集の個別編集ページ
app.get('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];

    let content = `<h2>${escapeHtml(set.title)} の編集</h2>`;
    content += `<form method="POST" action="/admin/edit/${idx}">`;
    (set.problems || []).forEach((p, i) => {
        content += `
          <div class="admin-row">
            <strong>ID: ${escapeHtml(String(p.id))}</strong> | 
            表示名: <input type="text" name="label_${i}" value="${escapeHtml(p.label)}" style="width:120px; display:inline;">
            正解: <input type="text" name="ans_${i}" value="${escapeHtml(p.correctAnswer)}" style="width:180px; display:inline;">
          </div>
        `;
    });
    content += `<button type="submit" style="width:100%; margin:20px 0;">変更を保存</button></form>`;

    // 問題の追加フォーム
    content += `
      <hr>
      <div class="set-card" style="background:#f9f9f9;">
          <h3>問題を追加</h3>
          <form method="POST" action="/admin/add-problem/${idx}">
            <label>追加する問題数: <input type="number" name="addCount" value="1" min="1" required style="width:80px; display:inline;"></label>
            <button type="submit">追加実行</button>
          </form>
      </div>
      <p><a href="/admin">管理者TOPに戻る</a></p>`;
    res.send(generatePage(null, content));
});

// ★復元: 問題追加処理
app.post('/admin/add-problem/:index', async (req, res) => {
    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send("問題集が見つかりません。");
    const set = sets[idx];

    const addCount = Math.max(1, Number(req.body.addCount) || 0);
    const existingIds = (set.problems || []).map(p => String(p.id));
    const numericIds = existingIds.map(id => { const n = Number(id); return Number.isFinite(n) && Number.isInteger(n) ? n : null; }).filter(x => x !== null);
    
    let nextNum = numericIds.length > 0 ? Math.max(...numericIds) + 1 : (set.problems || []).length + 1;

    for (let i = 0; i < addCount; i++) {
        const newId = String(nextNum + i);
        (set.problems = set.problems || []).push({ id: newId, label: `問${newId}`, correctAnswer: "" });
    }

    await saveSet(set);
    res.redirect(`/admin/edit/${idx}`);
});

app.post('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const idx = Number(req.params.index);
    const set = sets[idx];
    (set.problems || []).forEach((p, i) => {
        p.label = req.body[`label_${i}`] || p.label || String(p.id);
        p.correctAnswer = req.body[`ans_${i}`] || "";
    });
    await saveSet(set);
    res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
