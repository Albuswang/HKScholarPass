# HKScholarPass 部署指南

## 方案：使用 Railway + GitHub

Railway 支持定期运行任务（Cron Jobs），完美适合你的数据更新需求。

### 前置准备

1. **注册 GitHub 账号**
   - 访问 https://github.com/signup
   - 完成注册和邮箱验证

2. **注册 Railway 账号**
   - 访问 https://railway.app
   - 用 GitHub 账号登录（推荐）

### 部署步骤

#### 1️⃣ 上传代码到 GitHub

1. 在 GitHub 创建新仓库
   - 点击右上角 `+` → New repository
   - 仓库名：`hk-scholar-pass`（或自定义）
   - 选择 `Public`（这样网站可公开访问）
   - 点击 Create repository

2. 在你的电脑上初始化 Git
   ```bash
   cd d:\Projects\hk uni
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/hk-scholar-pass.git
   git push -u origin main
   ```
   （将 `YOUR_USERNAME` 替换为你的 GitHub 用户名）

#### 2️⃣ 部署到 Railway

1. 访问 https://railway.app/dashboard

2. 点击 `New Project` → 选择 `Deploy from GitHub`

3. 授权 Railway 访问你的 GitHub 账号

4. 选择 `hk-scholar-pass` 仓库

5. 点击 `Deploy`

6. 等待部署完成（通常 2-3 分钟）

#### 3️⃣ 配置公网 URL

1. 在 Railway 控制面板找到你的项目

2. 点击服务 → 点击 `Settings`

3. 找到 `Domains` 部分 → 点击 `Generate Domain`

4. 获得一个 Railway 提供的免费域名（如 `xxx.railway.app`）

5. 点击域名，可以在浏览器中访问你的网站

#### 4️⃣ 配置定期更新任务（可选但推荐）

**方式 A：使用 GitHub Actions（最简单）**

在你的仓库中创建文件：`.github/workflows/sync-data.yml`

```yaml
name: Sync Programme Data

on:
  schedule:
    - cron: '0 */6 * * *'  # 每 6 小时运行一次
  workflow_dispatch:  # 允许手动触发

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run sync:all
      - name: Commit and push
        run: |
          git config user.email "action@github.com"
          git config user.name "GitHub Action"
          git add official-programme-data.js
          git diff --quiet && git diff --staged --quiet || (git commit -m "Auto: Update programme data" && git push)
```

这样 GitHub 会自动每 6 小时爬取一次数据并更新。

**方式 B：使用 Railway Cron Jobs**

Railway 付费版支持 Cron Jobs，可联系他们客服配置。

### 验证部署

1. 访问你的 Railway 域名（如 `https://xxx.railway.app`）

2. 确认网站正常加载

3. 检查程序数据是否已更新（查看 `official-programme-data.js` 文件的 `updatedAt` 字段）

### 自定义域名（可选）

如果想用自己的域名（如 `scholarpass.com`）：

1. 在 Railway 项目设置中找到 `Domains`

2. 点击 `Add Custom Domain`

3. 输入你的域名

4. 按照 Railway 指示配置 DNS 记录

### 常见问题

**Q: 网站为什么无法访问？**
- 检查 Railway 日志是否有错误
- 确保 package.json 中的启动命令正确

**Q: 如何更新代码？**
- 修改本地代码 → git add → git commit → git push
- Railway 会自动检测并重新部署

**Q: 数据多久更新一次？**
- GitHub Actions 方案：每 6 小时
- 可自行修改 `.github/workflows/sync-data.yml` 中的 `cron` 时间表达式

### 成本

- **GitHub**：免费
- **Railway**：免费配额（每月 $5 额度，足够小型应用使用）

---

需要帮助吗？有任何问题都可以问！
