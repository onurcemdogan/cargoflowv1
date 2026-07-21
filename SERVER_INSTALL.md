# CargoFlow — Self-Hosted Kurulum (Ubuntu)

Tek port (**8787**) üzerinden hem API hem arayüz. Vite dev server **kullanılmaz**;
production build `dist/` klasöründen Express tarafından servis edilir.

## Gereksinimler

| Bileşen | Sürüm |
|---|---|
| Node.js | **>= 22.18, < 25** (sunucu `.ts` dosyalarını doğrudan çalıştırır) |
| PostgreSQL | 14+ (16 test edildi) |
| İşletim sistemi | Ubuntu 22.04 / 24.04 |

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs postgresql postgresql-contrib git
node -v    # v22.18+ olmalı
```

## A. İlk kurulum

```bash
# 1) Veritabanı
sudo -u postgres psql -c "CREATE USER cargoflow WITH PASSWORD 'GUCLU_PAROLA';"
sudo -u postgres psql -c "CREATE DATABASE cargoflow_db OWNER cargoflow;"

# 2) Kod
git clone https://github.com/onurcemdogan/cargoflowv1.git
cd cargoflowv1
npm ci

# 3) Ortam değişkenleri
cp .env.example .env
openssl rand -base64 32      # 5 kez çalıştırın (SESSION_SECRET + 4 şifreleme anahtarı)
nano .env
chmod 600 .env

# 4) Kurulum (migration + build + doğrulamalar)
npm run setup:server

# 5) İlk platform admin (parola gizli sorulur)
npm run platform-admin:create -- --username "admin"

# 6) Başlat
npm run start
```

`.env` içinde **mutlaka** doldurulması gerekenler:

```
DATABASE_URL=postgresql://cargoflow:GUCLU_PAROLA@127.0.0.1:5432/cargoflow_db
SESSION_SECRET=...
CREDENTIAL_ENCRYPTION_KEY=...
SHIPMENT_ENCRYPTION_KEY=...
ORDER_DATA_ENCRYPTION_KEY=...
PRODUCT_DATA_ENCRYPTION_KEY=...
APP_URL=http://192.168.1.150:8787
```

> **HTTPS yokken `COOKIE_SECURE=false` olmalıdır.** `true` bırakılırsa tarayıcı
> Secure cookie'yi düz HTTP üzerinden geri göndermez; login başarılı görünür
> ama sonraki her istek **401** döner. Domain + HTTPS'e geçince `true` yapın.

Eksik değişken varsa uygulama **sessizce başlamaz**; hangi değişkenin eksik
olduğunu yazıp durur.

### Kullanım

| Adres | Amaç |
|---|---|
| `http://SUNUCU_IP:8787/admin/login` | Platform yöneticisi paneli |
| `http://SUNUCU_IP:8787/login` | Organizasyon kullanıcısı girişi |

Organizasyon hesapları **yalnız** platform admin panelinden ("Yeni Şirket
Oluştur") veya güvenli CLI ile oluşturulur. Public self-servis kayıt
production'da kapalıdır.

## B. GitHub güncellemesi sonrası deploy

```bash
cd ~/cargoflowv1
git pull origin master
npm ci
npm run setup:server     # migration + build (veri SİLMEZ, tekrar çalıştırılabilir)
# PM2 kullanıyorsanız: pm2 restart cargoflow
npm run health
```

## C. Parola sıfırlama

```bash
# Platform admin
npm run platform-admin:reset-password -- --username "admin"

# Organizasyon kullanıcısı
npm run org-user:reset-password -- --username "oguz"
```

Terminal gizli prompt kabul etmiyorsa (otomasyon/etkileşimsiz kabuk):

```bash
printf '%s' 'YeniParola123' | npm run platform-admin:reset-password -- --username "admin" --password-stdin
```

## Doğrulama komutları

```bash
npm run health       # /api/health + veritabanı durumu
npm run db:verify    # bağlanılan DB, tablolar, hesapların hash uzunlukları
npm run db:check     # migration dosyaları tutarlı mı
npm run test:surat   # tam test paketi
```

`db:verify` çıktısında her hesabın `hashUzunluk=97 (GEÇERLİ)` olmalıdır.
`BOZUK` görürseniz ilgili parolayı **C** adımıyla sıfırlayın (elle SQL ile
hash yazmayın).

## Sorun giderme

| Belirti | Sebep / Çözüm |
|---|---|
| Login 200 ama sonraki istekler 401 | `COOKIE_SECURE=true` + düz HTTP → `.env`'de `false` yapın |
| Başlangıçta "zorunlu ortam değişkenleri eksik" | `.env`'de listelenen değişkenleri doldurun |
| `tsc: not found` | `npm ci` çalıştırın (devDependencies gerekli) |
| Port 8787 dolu | Eski süreç/Vite dev server açık: `lsof -i :8787` ile bulup kapatın |
| CLI parola sorarken takılıyor | TTY yok → `--password-stdin` kullanın |
| `db:verify` hash uzunluğu ≠ 97 | Hash bozuk → **C** adımıyla parolayı sıfırlayın |

## Sonraki aşama: domain + HTTPS + PM2

Repoda hazır dosyalar:

- `ecosystem.config.cjs` — PM2 (tek instance; idempotency in-process kilitleri
  çoklu süreç desteklemez)
- `deploy/nginx/cargoflow.conf` — Nginx reverse proxy + HTTPS

Geçişte `.env` içinde: `HOST=127.0.0.1`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`,
`APP_URL=https://alanadiniz.com`.
