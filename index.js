const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { MongoClient, ObjectId } = require('mongodb'); // ← ObjectId 追加（念のため）
require('dotenv').config();

const app = express();

// --- ミドルウェア ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- MongoDB ---
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
let db;

async function connectDB() {
    if (db) return db;
    await client.connect();
    db = client.db('study_app');
    return db;
}

app.use(async (req, res, next) => {
    try { await connectDB(); next(); } 
    catch (err) { res.status(503).send("DB接続エラー"); }
});

// --- ID比較ヘルパー（これが最重要！）---
const idEqual = (a, b) => !!(a && b && String(a) === String(b));

// --- データ操作関数 ---
const loadSets = async () => {
    return await db.collection('problem_sets').find({}).toArray();
};

const saveSet = async (set) => {
    const col = db.collection('problem_sets');
    if (set._id) {
        const { _id, ...updateData } = set;
        await col.updateOne({ _id }, { $set: updateData });
    } else {
        await col.insertOne(set);
    }
};

const loadUsers = async () => {
    return await db.collection('users').find({}).toArray();
};

// --- HTML生成 ---
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
                          text-align: center; border: 2px solid #ccc; margin: 4px; 
                          border-radius: 8px; font-size: 18px; cursor: pointer; }
            .progress-bar { background: #eee; height: 25px; border-radius: 12px; margin: 12px 0; overflow: hidden; }
            .progress-fill { background: linear-gradient(90deg, #28a745, #34d058); height: 100%; transition: width 0.6s ease; }
        </style>
    </head>
    <body>
        <nav>
            <a href="/"> HOME</a> | 
            <a href="/admin"> 解答設定</a> | 
            ${user ? ` ${user.username} <a href="/logout">ログアウト</a>` : '<a href="/login">ログイン</a>'}
        </nav>
        <main>${content}</main>
    </body>
    </html>
`;

// ====================== ログイン・ログアウト ======================
app.get('/login', (req, res) => {
    res.send(generatePage(null, `
        <h2>ログイン</h2>
        <form method="POST" action="/login">
            <input type="text" name="username" placeholder="ユーザー名（例: taro）" required autofocus>
            <button type="submit">ログイン</button>
        </form>
        <p>初めての場合は自動でアカウント作成されます</p>
    `));
});

app.post('/login', async (req, res) => {
    let { username } = req.body;
    username = username.trim();
    if (!username) return res.redirect('/login');

    const col = db.collection('users');
    let user = await col.findOne({ username });
    if (!user) {
        await col.insertOne({ username, submissions: [] });
    }

    res.cookie('username', username, { httpOnly: true, maxAge: 30*24*60*60*1000 });
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    res.clearCookie('username');
    res.redirect('/login');
});

// ====================== メインルート ======================

// 1. ホーム（問題集一覧＋進捗）
app.get('/', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const users = await loadUsers();
    const user = users.find(u => u.username === username);
    if (!user) return res.redirect('/login');

    let content = `<h2>📚 問題集一覧</h2>`;
    sets.forEach((set, idx) => {
        const userSubs = user.submissions || [];
        const solvedCount = set.problems.filter(p =>
            userSubs.some(s =>
                idEqual(s.setId, set._id) &&
                idEqual(s.probId, p.id) &&
                s.result === 'CA'
            )
        ).length;

        const progress = (solvedCount / set.problems.length) * 100;

        content += `
            <div style="border: 1px solid #ddd; padding: 20px; margin-bottom: 15px; border-radius: 12px;">
                <h3>${set.title}</h3>
                <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
                <p><strong>進捗: ${solvedCount} / ${set.problems.length} (${Math.round(progress)}%)</strong></p>
                <a href="/set/${idx}" style="font-size:18px;">🚀 問題を解く →</a>
            </div>
        `;
    });

    res.send(generatePage(user, content));
});

// 2. 問題一覧ページ（CA/WAグリッド）
app.get('/set/:index', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const setIndex = parseInt(req.params.index);
    if (isNaN(setIndex) || !sets[setIndex]) return res.status(404).send('問題集が見つかりません');

    const set = sets[setIndex];
    const users = await loadUsers();
    const user = users.find(u => u.username === username);

    let content = `<h2>${set.title}</h2><div style="display: flex; flex-wrap: wrap; gap: 8px;">`;
    
    set.problems.forEach(prob => {
        const userSubs = user.submissions || [];
        const sub = userSubs.find(s => 
            idEqual(s.setId, set._id) && idEqual(s.probId, prob.id)
        );

        const resultClass = sub ? sub.result.toLowerCase() : '';
        const resultLabel = sub ? sub.result : prob.id;

        content += `
            <div class="status-box ${resultClass}" 
                 onclick="location.href='/submit/${setIndex}/${prob.id}'">
                ${resultLabel}
            </div>
        `;
    });

    content += `</div><p style="margin-top:20px;"><a href="/">← 戻る</a></p>`;
    res.send(generatePage(user, content));
});

// 3. 回答フォーム＆判定
app.get('/submit/:setIdx/:probId', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    res.send(generatePage({username}, `
        <h3>問題 ${req.params.probId} の回答</h3>
        <form method="POST">
            <input type="text" name="answer" placeholder="答えを入力" autofocus style="width:300px;padding:12px;font-size:18px;">
            <button type="submit" style="padding:12px 24px;font-size:18px;">判定！</button>
        </form>
        <p><a href="/set/${req.params.setIdx}">← 問題一覧に戻る</a></p>
    `));
});

app.post('/submit/:setIdx/:probId', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const setIdx = parseInt(req.params.setIdx);
    const { probId } = req.params;
    const { answer } = req.body;

    const sets = await loadSets();
    const set = sets[setIdx];
    if (!set) return res.status(404).send('問題集が見つかりません');

    const problem = set.problems.find(p => p.id === probId);
    if (!problem) return res.status(404).send('問題が見つかりません');

    const result = (answer.trim() === problem.correctAnswer) ? 'CA' : 'WA';

    const col = db.collection('users');
    // 古い記録を削除
    await col.updateOne(
        { username },
        { $pull: { submissions: { setId: set._id, probId } } }
    );
    // 新しい記録を追加
    await col.updateOne(
        { username },
        { $push: { submissions: { setId: set._id, probId, result, date: new Date() } } }
    );

    const color = result === 'CA' ? 'green' : 'red';
    res.send(generatePage({username}, `
        <h1 style="color:${color}; font-size:80px; margin:40px 0;">${result}</h1>
        <p>あなたの回答: <strong>${answer}</strong></p>
        <a href="/set/${setIdx}" style="font-size:20px;">→ 問題一覧に戻る</a>
    `));
});

// 4. 管理者ページ（変更なし）
app.get('/admin', async (req, res) => {
    const sets = await loadSets();
    let content = `<h2>解答設定・問題集追加</h2>
        <form action="/admin/add-set" method="POST">
            <input type="text" name="title" placeholder="問題集タイトル" required>
            <input type="number" name="count" placeholder="問題数" min="1" required>
            <button type="submit">新規作成</button>
        </form>
        <hr>
        <h3>既存の問題集</h3><ul>`;
    
    sets.forEach((set, idx) => {
        content += `<li>${set.title} <a href="/admin/edit/${idx}">正解を編集</a></li>`;
    });
    content += `</ul>`;
    res.send(generatePage(null, content));
});

app.post('/admin/add-set', async (req, res) => {
    const { title, count } = req.body;
    const problems = Array.from({length: parseInt(count)}, (_, i) => ({
        id: (i+1).toString(),
        correctAnswer: ""
    }));
    await saveSet({ title, problems });
    res.redirect('/admin');
});

app.get('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const set = sets[parseInt(req.params.index)];
    let content = `<h2>${set.title} の正解設定</h2>
        <form method="POST">`;
    set.problems.forEach((p, i) => {
        content += `
            <div style="margin:10px 0;">
                問${p.id}: 
                <input type="text" name="ans_${i}" value="${p.correctAnswer || ''}" style="width:300px;">
            </div>`;
    });
    content += `<button type="submit">保存</button></form>`;
    res.send(generatePage(null, content));
});

app.post('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const set = sets[parseInt(req.params.index)];
    set.problems.forEach((p, i) => {
        p.correctAnswer = req.body[`ans_${i}`] || "";
    });
    await saveSet(set);
    res.redirect('/admin');
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(` Server running → http://localhost:${PORT}`));
