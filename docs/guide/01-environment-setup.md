# 開発環境のセットアップ

## 目標

LocalStack と AWS CDK を使った開発環境を構築し、ローカルで AWS サービスをエミュレートできる状態にします。

---

## 背景情報

### なぜ LocalStack を使うのか

AWS の実環境で開発を行う場合、以下の課題があります：

- **コスト**: 開発・テスト中も AWS 利用料が発生
- **速度**: デプロイに時間がかかる
- **制限**: IAM 権限やリソース制限による開発の遅延
- **リスク**: 本番環境への誤操作の可能性

LocalStack は、ローカルマシン上で AWS サービスをエミュレートすることで、これらの課題を解決します。

### LocalStack の特徴

| 特徴                   | 説明                                 |
| ---------------------- | ------------------------------------ |
| **完全ローカル**       | インターネット接続不要で開発可能     |
| **高速フィードバック** | デプロイが数秒で完了                 |
| **無料利用**           | Community 版で主要サービスが利用可能 |
| **AWS 互換**           | AWS CLI や SDK がそのまま使える      |

### AWS CDK とは

AWS Cloud Development Kit（CDK）は、プログラミング言語で AWS インフラを定義できる IaC ツールです。

```typescript
// CDKでLambda関数を定義する例
const orderFunction = new lambda.Function(this, "OrderFunction", {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("lambda/order"),
});
```

**CDK のメリット:**

- TypeScript の型安全性を活用
- 抽象化されたコンストラクトで記述量削減
- 既存のプログラミングスキルを活用

---

## 前提条件

以下がインストールされていることを確認してください：

- Node.js 20.x 以上
- Docker Desktop（LocalStack 実行に必要）
- pnpm（推奨）または npm

---

## セットアップ手順

### Step 1: プロジェクトの初期化

```bash
# プロジェクトディレクトリの作成
mkdir eda-learning
cd eda-learning

# pnpmの初期化
pnpm init

# TypeScriptと必要なパッケージのインストール
pnpm add -D typescript @types/node ts-node
pnpm add -D aws-cdk aws-cdk-lib constructs
pnpm add -D esbuild
pnpm add @aws-sdk/client-eventbridge @aws-sdk/client-dynamodb @aws-sdk/client-sqs @aws-sdk/client-sns
```

### Step 2: TypeScript 設定

```bash
# tsconfig.jsonの作成
npx tsc --init
```

### Step 3: LocalStack のセットアップ

```bash
# LocalStack CLIのインストール
pip install localstack

# または Homebrew（macOS）
brew install localstack/tap/localstack-cli

# awscli-localのインストール（awslocalコマンド）
pip install awscli-local
```

### Step 4: Docker Compose の設定

プロジェクトルートに `docker-compose.yml` を作成します。

### Step 5: CDK プロジェクトの構造作成

```
eda-learning/
├── bin/
│   └── app.ts              # CDKアプリのエントリーポイント
├── lib/
│   └── eda-stack.ts        # メインスタック定義
├── lambda/
│   └── order/
│       └── index.ts        # Lambda関数
├── docker-compose.yml      # LocalStack設定
├── cdk.json               # CDK設定
├── tsconfig.json          # TypeScript設定
└── package.json
```

---

## コードサンプル

### docker-compose.yml

```yaml
version: "3.8"

services:
  localstack:
    image: localstack/localstack:latest
    container_name: localstack
    ports:
      - "4566:4566" # LocalStack Gateway
      - "4510-4559:4510-4559" # 外部サービス用ポート
    environment:
      - DEBUG=1
      - DOCKER_HOST=unix:///var/run/docker.sock
      - LOCALSTACK_HOST=localhost
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock"
      - "./localstack-data:/var/lib/localstack"
```

### cdk.json

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "watch": {
    "include": ["**"],
    "exclude": [
      "README.md",
      "cdk*.json",
      "**/*.d.ts",
      "**/*.js",
      "tsconfig.json",
      "package*.json",
      "node_modules",
      "test"
    ]
  },
  "context": {
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:stackRelativeExports": true
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": false,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "strictPropertyInitialization": false,
    "outDir": "./dist",
    "rootDir": ".",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "exclude": ["node_modules", "cdk.out"]
}
```

### bin/app.ts

```typescript
#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { EdaStack } from "../lib/eda-stack";

const app = new cdk.App();

new EdaStack(app, "EdaStack", {
  env: {
    account: "000000000000", // LocalStack用のダミーアカウント
    region: "ap-northeast-1",
  },
});
```

### lib/eda-stack.ts

```typescript
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ここにリソースを追加していきます
    // 次のステップ以降で実装
  }
}
```

---

## 課題

### 課題 1: 環境構築の完了

上記の手順に従って、開発環境を構築してください。

**完了条件:**

1. `docker compose up -d` で LocalStack が起動する
2. `awslocal sts get-caller-identity` が成功する
3. `npx cdk synth` がエラーなく完了する

<details>
<summary>ヒント 1: LocalStackが起動しない場合</summary>

Docker Desktop が起動しているか確認してください。また、ポート 4566 が他のプロセスで使用されていないか確認します。

```bash
# ポート確認
lsof -i :4566
```

</details>

<details>
<summary>ヒント 2: awslocalコマンドが見つからない場合</summary>

`awscli-local`がインストールされているか確認してください。

```bash
pip install awscli-local

# または pipx を使用
pipx install awscli-local
```

</details>

<details>
<summary>回答: 完全なpackage.json</summary>

```json
{
  "name": "eda-learning",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "cdk": "cdk",
    "synth": "cdk synth",
    "deploy": "cdk deploy --require-approval never",
    "deploy:local": "cdklocal deploy --require-approval never",
    "destroy": "cdk destroy",
    "localstack:up": "docker compose up -d",
    "localstack:down": "docker compose down",
    "localstack:logs": "docker compose logs -f"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "aws-cdk": "^2.170.0",
    "aws-cdk-lib": "^2.170.0",
    "aws-cdk-local": "^2.18.0",
    "constructs": "^10.3.0",
    "esbuild": "^0.24.0",
    "source-map-support": "^0.5.21",
    "ts-node": "^10.9.2",
    "typescript": "^5.3.0"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.700.0",
    "@aws-sdk/client-eventbridge": "^3.700.0",
    "@aws-sdk/client-sns": "^3.700.0",
    "@aws-sdk/client-sqs": "^3.700.0"
  }
}
```

</details>

### 課題 2: LocalStack の動作確認

LocalStack が正しく動作していることを確認するため、S3 バケットを作成・削除してみましょう。

```bash
# バケット作成
awslocal s3 mb s3://test-bucket

# バケット一覧
awslocal s3 ls

# バケット削除
awslocal s3 rb s3://test-bucket
```

<details>
<summary>ヒント: エンドポイントエラーが出る場合</summary>

LocalStack が起動しているか確認してください。

```bash
# LocalStackの状態確認
docker compose ps

# ログ確認
docker compose logs localstack
```

</details>

<details>
<summary>回答: 期待される出力</summary>

```bash
$ awslocal s3 mb s3://test-bucket
make_bucket: test-bucket

$ awslocal s3 ls
2024-12-21 10:00:00 test-bucket

$ awslocal s3 rb s3://test-bucket
remove_bucket: test-bucket
```

</details>

---

## cdklocal のセットアップ

LocalStack で CDK を使用するには、`aws-cdk-local`パッケージを使用します。

```bash
# インストール
pnpm add -D aws-cdk-local

# 使用方法
npx cdklocal bootstrap
npx cdklocal deploy
```

`cdklocal`は内部的に LocalStack のエンドポイント（`http://localhost:4566`）を使用するように CDK を設定します。

---

## トラブルシューティング

### よくある問題と解決策

| 問題                      | 原因                              | 解決策                                      |
| ------------------------- | --------------------------------- | ------------------------------------------- |
| LocalStack が起動しない   | Docker が起動していない           | Docker Desktop を起動                       |
| ポート 4566 が使用中      | 他のプロセスが使用                | `lsof -i :4566`で確認し、プロセスを終了     |
| cdklocal bootstrap が失敗 | LocalStack が完全に起動していない | 数秒待ってから再実行                        |
| TypeScript エラー         | 型定義の不足                      | `@types/node`がインストールされているか確認 |

---

## 確認クイズ

<details>
<summary>Q1: LocalStackを使う主なメリットを3つ挙げてください</summary>

**A1:**

1. コスト削減（AWS 利用料が発生しない）
2. 高速なフィードバック（ローカルでのデプロイが数秒）
3. オフライン開発が可能

</details>

<details>
<summary>Q2: cdklocalとcdkの違いは何ですか？</summary>

**A2:** `cdklocal`は LocalStack のエンドポイント（localhost:4566）を使用するように設定された CDK のラッパーです。通常の`cdk`コマンドは AWS の実環境にデプロイしますが、`cdklocal`は LocalStack にデプロイします。

</details>

<details>
<summary>Q3: LocalStackで使用するAWSアカウントIDは何ですか？</summary>

**A3:** `000000000000`（12 桁のゼロ）です。これは LocalStack のデフォルトのダミーアカウント ID です。

</details>

---

## 次のステップ

次のステップでは、EventBridge の基礎を学び、イベントバスとルールを作成します。

[← イントロダクション](./00-introduction.md) | [EventBridge 基礎 →](./02-eventbridge-basics.md)
