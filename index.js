const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();

// --- ミドルウェア ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- MongoDB 接続設定 ---
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
let db;

async function connectDB() {
    if (db) return db;
    await client.connect();
    db = client.db('study_app'); // データベース名
    return db;
}

// 全リクエストでDB接続を確認
app.use(async (req, res, next) => {
    try { await connectDB(); next(); } 
    catch (err) { res.status(503).send("DB接続エラー"); }
});

// --- データ操作関数 ---
const loadSets = async () => {
    const col = db.collection('problem_sets');
    return await col.find({}).toArray();
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
            .status-box { display: inline-block; width: 30px; height: 30px; line-height: 30px; 
                          text-align: center; border: 1px solid #ccc; margin: 2px; border-radius: 4px; }
            .progress-bar { background: #eee; height: 20px; border-radius: 10px; margin: 10px 0; }
            .progress-fill { background: #28a745; height: 100%; border-radius: 10px; transition: width 0.5s; }
        </style>
    </head>
    <body>
        <nav>
            <a href="/">HOME</a> | <a href="/admin">解答設定</a> | 
            ${user ? `<span>Hi, ${user.username}</span> <a href="/logout">Logout</a>` : '<a href="/login">Login</a>'}
        </nav>
        <main>${content}</main>
    </body>
    </html>
`;

// --- ルート設定 ---

// 1. 問題集一覧・進捗表示
app.get('/', async (req, res) => {
    const username = req.cookies.username;
    if (!username) return res.redirect('/login');

    const sets = await loadSets();
    const users = await loadUsers();
    const user = users.find(u => u.username === username);
    
    let content = `<h2>問題集一覧</h2>`;
    sets.forEach((set, idx) => {
        const solvedCount = set.problems.filter(p => 
            user.submissions && user.submissions.find(s => s.setId == set._id && s.probId == p.id && s.result == 'CA')
        ).length;
        const progress = (solvedCount / set.problems.length) * 100;

        content += `
            <div style="border: 1px solid #ddd; padding: 15px; margin-bottom: 10px;">
                <h3>${set.title}</h3>
                <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
                <p>進捗: ${solvedCount} / ${set.problems.length} ( ${Math.round(progress)}% )</p>
                <a href="/set/${idx}">問題を解く</a>
            </div>
        `;
    });
    res.send(generatePage(user, content));
});

// 2. 問題回答ページ（ここがメイン！）
app.get('/set/:index', async (req, res) => {
    const username = req.cookies.username;
    const sets = await loadSets();
    const set = sets[req.params.index];
    const users = await loadUsers();
    const user = users.find(u => u.username === username);

    let content = `<h2>${set.title}</h2><div style="display: flex; flex-wrap: wrap;">`;
    
    set.problems.forEach(prob => {
        const sub = (user.submissions || []).find(s => s.setId == set._id && s.probId == prob.id);
        const resultClass = sub ? sub.result.toLowerCase() : '';
        const resultLabel = sub ? sub.result : prob.id;

        content += `
            <div class="status-box ${resultClass}" onclick="location.href='/submit/${req.params.index}/${prob.id}'" style="cursor:pointer">
                ${resultLabel}
            </div>
        `;
    });

    content += `</div><p><a href="/">戻る</a></p>`;
    res.send(generatePage(user, content));
});

// 3. 判定ロジック (CA/WA)
app.get('/submit/:setIdx/:probId', async (req, res) => {
    const { setIdx, probId } = req.params;
    res.send(generatePage({username: req.cookies.username}, `
        <h3>問題 ${probId} の回答</h3>
        <form method="POST">
            <input type="text" name="answer" placeholder="答えを入力" autofocus>
            <button type="submit">判定！</button>
        </form>
    `));
});

app.post('/submit/:setIdx/:probId', async (req, res) => {
    const { setIdx, probId } = req.params;
    const { answer } = req.body;
    const sets = await loadSets();
    const set = sets[setIdx];
    const problem = set.problems.find(p => p.id == probId);
    
    const result = (answer.trim() === problem.correctAnswer) ? 'CA' : 'WA';
    
    // ユーザー情報の更新
    const col = db.collection('users');
    await col.updateOne(
        { username: req.cookies.username },
        { $pull: { submissions: { setId: set._id, probId: probId } } } // 古い記録を消す
    );
    await col.updateOne(
        { username: req.cookies.username },
        { $push: { submissions: { setId: set._id, probId: probId, result, date: new Date() } } }
    );

    const color = result === 'CA' ? 'green' : 'red';
    res.send(generatePage({username: req.cookies.username}, `
        <h1 style="color: ${color}">${result}</h1>
        <p>回答: ${answer}</p>
        <a href="/set/${setIdx}">問題一覧に戻る</a>
    `));
});

// 4. 解答設定ページ（管理者向け）
app.get('/admin', async (req, res) => {
    const sets = await loadSets();
    let content = `<h2>解答設定・問題集追加</h2>
        <form action="/admin/add-set" method="POST">
            <input type="text" name="title" placeholder="問題集タイトル (例: 青チャート数IA)">
            <input type="number" name="count" placeholder="問題数">
            <button type="submit">新規作成</button>
        </form>
        <hr>
        <h3>既存の問題集の正解を設定</h3>`;
    
    sets.forEach((set, idx) => {
        content += `<li>${set.title} <a href="/admin/edit/${idx}">正解を編集する</a></li>`;
    });
    res.send(generatePage(null, content));
});

app.post('/admin/add-set', async (req, res) => {
    const { title, count } = req.body;
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
    const set = sets[req.params.index];
    let content = `<h2>${set.title} の正解設定</h2><form method="POST">`;
    set.problems.forEach((p, i) => {
        content += `<div>問${p.id}: <input type="text" name="ans_${i}" value="${p.correctAnswer}"></div>`;
    });
    content += `<button type="submit">保存</button></form>`;
    res.send(generatePage(null, content));
});

app.post('/admin/edit/:index', async (req, res) => {
    const sets = await loadSets();
    const set = sets[req.params.index];
    set.problems.forEach((p, i) => {
        p.correctAnswer = req.body[`ans_${i}`];
    });
    await saveSet(set);
    res.redirect('/admin');
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
