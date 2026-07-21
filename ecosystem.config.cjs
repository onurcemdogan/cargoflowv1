// PM2 process yapılandırması (self-hosted Ubuntu).
// Proje ESM olduğu için bu dosya .cjs uzantılıdır.
// SECRET BURAYA YAZILMAZ: uygulama başlarken proje kökündeki .env dosyasını
// kendisi okur (server/index.mjs → loadLocalEnvFile). .env git'e girmez.
module.exports = {
  apps: [
    {
      name: 'cargoflow',
      script: 'server/index.mjs',
      // Sunucudaki proje dizini (git clone edilen yer).
      cwd: '/var/www/cargoflow',
      // Tek instance: Sürat create idempotency ve in-process kilitler tek
      // süreç varsayar. cluster/çoklu instance KULLANMAYIN.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Bellek sızıntısına karşı emniyet; veri PostgreSQL'de olduğu için
      // yeniden başlatma veri kaybettirmez.
      max_memory_restart: '512M',
      // .env dosyasındaki değerler process.env'i EZMEZ; burada yalnız
      // minimum güvenli varsayılanlar tanımlanır.
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/cargoflow/error.log',
      out_file: '/var/log/cargoflow/out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
