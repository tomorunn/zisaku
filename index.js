// app.js (修正版)
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
    db = client.db('study_app'); // データベース名
    // ensure indexes (optional)
    await db.collection('users').createIndex({ username: 1 }, { unique: true }).catch(()=>{});
    return db;
}

// 既存の app.use(async (req,res,next) => { ... }) の catch を次に置き換え
app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) {
    console.error("=== DB接続エラーの詳細 ===");
    console.error(err); // ← ここでエラー内容をコンソールに出力します
    res.status(503).send("DB接続エラー (詳細はサーバーコンソールを確認してください)");
  }
});

// --- データ操作関数 ---
const loadSets = async () => {
    const col = db.collection('problem_sets');
    const sets = await col.find({}).toArray();
    // 注意: _id は ObjectId のままにしておく（必要なら toString() を使う）
    return sets;
};

const saveSet = async (set) => {
    const col = db.collection('problem_sets');
    if (set._id) {
        const { _id, ...updateData } = set;
        await col.updateOne({ _id: ObjectId(isValidObjectIdString(_id) ? _id : _id.toString()) }, { $set: updateData });
    } else {
        await col.insertOne(set);
    }
};

const loadUsers = async () => {
    return await db.collection('users').find({}).toArray();
};

function isValidObjectIdString(s) {
    try {
        return ObjectId.isValid(s);
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
        <title>Study Gamification</title>
        <link rel="stylesheet" href="/style.css">
        <style>
            .ca { background-color: #d4edda; color: #155724; font-weight: bold; }
            .wa { background-color: #f8d7da; color: #721c24; }
            .status-box { display: inline-block; width: 40px; height: 40px; line-height: 40px; 
                          text-align: center; border: 1px solid #ccc; margin: 4px; border-radius: 6px; }
            .progress-bar { background: #eee; height: 20px; border-radius: 10px; margin: 10px 0; overflow: hidden; }
            .progress-fill { background: #28a745; height: 100%; border-radius: 10px; transition: width 0.5s; }
            nav { margin-bottom: 10px; }
        </style>
    </head>
    <body>
        <nav>
            <a href="/">HOME</a> | <a href="/admin">解答設定</a> |
            ${user ? `<span>Hi, ${escapeHtml(user.username)}</span> <a href="/logout">Logout</a>` : '<a href="/login">Login</a>'}
        </nav>
        <main>${content}</main>
    </body>
    </html>
`;

// simple HTML escape
function escapeHtml(s = '') {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- 認証（簡易） ---
// GET /login
app.get('/login', (req, res) => {
    const content = `
        <h2>ログイン</h2>
        <form method="POST" action="/login">
            <input name="username" placeholder="ユーザー名" required>
            <button type="submit">ログイン</button>
        </form>
    `;
    res.send(generatePage(null, content));
});

// POST /login
app.post('/login', async (req, res) => {
    const username = (req.body.username || '').trim();
    if (!username) return res.redirect('/login');

    const col = db.collection('users');
    // create user if not exists
    await col.updateOne(
        { username },
        { $setOnInsert: { username, submissions: [] } },
        { upsert: true }
    );
    res.cookie('username', username, { httpOnly: true });
    res.redirect('/');
});

// GET /logout
app.get('/logout', (req, res) => {
    res.clearCookie('username');
    res.redirect('/login');
});

// --- ルート設定 ---

// 1. 問題集一覧・進捗表示
app.get('/', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const users = await loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) {
        // safety: create user doc and reload
        await db.collection('users').updateOne({ username }, { $setOnInsert: { username, submissions: [] } }, { upsert: true });
    }

    const curUser = await db.collection('users').findOne({ username }); // fresh
    let content = `<h2>問題集一覧</h2>`;
    sets.forEach((set, idx) => {
        const setIdStr = String(set._id);
        const solvedCount = (set.problems || []).filter(p => 
            (curUser.submissions || []).find(s => s.setId === setIdStr && s.probId == p.id && s.result === 'CA')
        ).length;
        const total = set.problems ? set.problems.length : 0;
        const progress = total > 0 ? (solvedCount / total) * 100 : 0;

        content += `
            <div style="border: 1px solid #ddd; padding: 15px; margin-bottom: 10px;">
                <h3>${escapeHtml(set.title || `問題集 ${idx}`)}</h3>
                <div class="progress-bar"><div class="progress-fill" style="width: ${Math.round(progress)}%"></div></div>
                <p>進捗: ${solvedCount} / ${total} ( ${Math.round(progress)}% )</p>
                <a href="/set/${idx}">問題を解く</a>
            </div>
        `;
    });
    res.send(generatePage(curUser, content));
});

// 2. 問題回答ページ
app.get('/set/:index', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    const user = await db.collection('users').findOne({ username });

    let content = `<h2>${escapeHtml(set.title)}</h2><div style="display: flex; flex-wrap: wrap;">`;
    
    (set.problems || []).forEach(prob => {
        const sub = (user && user.submissions || []).find(s => s.setId === String(set._id) && s.probId == prob.id);
        const resultClass = sub ? sub.result.toLowerCase() : '';
        const resultLabel = sub ? sub.result : prob.id;

        content += `
            <div class="status-box ${resultClass}" onclick="location.href='/submit/${idx}/${prob.id}'" style="cursor:pointer">
                ${escapeHtml(resultLabel)}
            </div>
        `;
    });

    content += `</div><p><a href="/">戻る</a></p>`;
    res.send(generatePage(user, content));
});

// 3. 判定ロジック (CA/WA)
// GET: 回答入力フォーム
app.get('/submit/:setIdx/:probId', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const idx = Number(req.params.setIdx);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    const problem = (set.problems || []).find(p => p.id == req.params.probId);
    if (!problem) return res.status(404).send(generatePage(null, `<p>問題が見つかりません。</p>`));

    res.send(generatePage({username}, `
        <h3>${escapeHtml(set.title)} - 問${escapeHtml(problem.id)}</h3>
        <form method="POST">
            <input type="text" name="answer" placeholder="答えを入力" autofocus required>
            <button type="submit">判定！</button>
        </form>
        <p><a href="/set/${idx}">戻る</a></p>
    `));
});

// POST: 判定処理（堅牢版）
app.post('/submit/:setIdx/:probId', async (req, res) => {
  try {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const { setIdx, probId } = req.params;
    const rawAnswer = (req.body.answer || '').toString();

    const sets = await loadSets();
    const idx = Number(setIdx);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    const problem = (set.problems || []).find(p => p.id == probId);
    if (!problem) return res.status(404).send(generatePage(null, `<p>問題が見つかりません。</p>`));

    // ノーマライズ関数: 文字列比較の前に数値かどうかをチェックして数値比較をする
    const normalizeStr = s => (s || '').toString().trim();
    const isNumericString = s => {
      // 整数、小数、指数表記、先頭の +/- を許可
      return /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(String(s).trim());
    };

    const numericEqual = (aStr, bStr) => {
      const a = Number(aStr);
      const b = Number(bStr);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      // 許容誤差（浮動小数点の比較）: 必要に応じて調整
      const EPS = 1e-9;
      return Math.abs(a - b) <= EPS;
    };

    const normalizeLower = s => normalizeStr(s).toLowerCase();

    // 判定ロジック: 両方が「数値らしい」なら数値比較、それ以外は小文字の文字列比較
    let isCorrect = false;
    const expected = problem.correctAnswer || "";
    const given = rawAnswer;

    if (isNumericString(expected) && isNumericString(given)) {
      isCorrect = numericEqual(expected, given);
    } else {
      // 非数値は trim + lowercase 比較（空白や大文字小文字を無視）
      isCorrect = normalizeLower(expected) === normalizeLower(given);
    }

    const result = isCorrect ? 'CA' : 'WA';
    const col = db.collection('users');

    // ensure user exists
    await col.updateOne(
      { username },
      { $setOnInsert: { username, submissions: [] } },
      { upsert: true }
    );

    // remove old submission for same problem & set, then push new (and store rawAnswer for debugging)
    const setIdStr = String(set._id);
    await col.updateOne(
      { username },
      { $pull: { submissions: { setId: setIdStr, probId: probId } } }
    );
    await col.updateOne(
      { username },
      { $push: { submissions: { setId: setIdStr, probId: probId, result, answer: String(rawAnswer), date: new Date() } } }
    );

    const color = result === 'CA' ? 'green' : 'red';
    res.send(generatePage({username}, `
        <h1 style="color: ${color}">${result}</h1>
        <p>回答: ${escapeHtml(rawAnswer)}</p>
        <p>正解: ${escapeHtml(expected || '(未設定)')}</p>
        <a href="/set/${idx}">問題一覧に戻る</a>
    `));
  } catch (err) {
    console.error('POST /submit error:', err);
    res.status(500).send(generatePage(null, `<p>内部エラーが発生しました。サーバーログを確認してください。</p>`));
  }
});


// 4. 解答設定ページ（管理者向け、簡易）
app.get('/admin', async (req, res) => {
    const sets = await loadSets();
    let content = `<h2>解答設定・問題集追加</h2>
        <form action="/admin/add-set" method="POST">
            <input type="text" name="title" placeholder="問題集タイトル (例: 青チャート数IA)" required>
            <input type="number" name="count" placeholder="問題数" min="1" required>
            <button type="submit">新規作成</button>
        </form>
        <hr>
        <h3>既存の問題集の正解を設定</h3>
        <ul>
    `;
    
    sets.forEach((set, idx) => {
        content += `<li>${escapeHtml(set.title || `問題集 ${idx}`)} <a href="/admin/edit/${idx}">正解を編集する</a></li>`;
    });
    content += `</ul>`;
    res.send(generatePage(null, content));
});

app.post('/admin/add-set', async (req, res) => {
    const title = (req.body.title || '').toString().trim() || '無題';
    const count = Math.max(1, Number(req.body.count) || 0);
    const problems = [];
    for (let i = 1; i <= count; i++) {
        problems.push({ id: i.toString(), correctAnswer: "" });
    }
    await saveSet({ title, problems });
    res.redirect('/admin');
});

// 正解編集ページ
app.get('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    let content = `<h2>${escapeHtml(set.title)} の正解設定</h2><form method="POST">`;
(set.problems || []).forEach((p, i) => {
    // 明示的に String() で変換してから escapeHtml に渡す（null/undefined 対策）
    const val = escapeHtml(String(p.correctAnswer || ''));
    content += `<div>問${escapeHtml(p.id)}: <input type="text" name="ans_${i}" value="${val}" placeholder="例: -1, 0.5, 記述式 など（任意）"></div>`;
});
    res.send(generatePage(null, content));
});

app.post('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const idx = Number(req.params.index);
    if (Number.isNaN(idx) || idx < 0 || idx >= sets.length) return res.status(404).send(generatePage(null, `<p>問題集が見つかりません。</p>`));
    const set = sets[idx];
    (set.problems || []).forEach((p, i) => {
        p.correctAnswer = req.body[`ans_${i}`] || "";
    });
    await saveSet(set);
    res.redirect('/admin');
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
