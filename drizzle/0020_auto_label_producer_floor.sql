-- HOTFIX-LABEL-PERF — otomatik etiket üreticisi alt sınırı (yıkıcı DEĞİL).
--
-- Bu sürümle üretici aday penceresi en yeniden başlar ve işlenmiş paketleri
-- dışlar. Eski sürümde pencere tıkandığı için aktivasyon sınırından sonra
-- görülmüş ama hiç incelenmemiş paketler birikmişti; bunlar (geri alınamaz,
-- faturalanabilir) otomatik İŞLENMESİN diye otomatik etiketi AÇIK kiracılara
-- bu dağıtımın anı `autoLabel.producerFloorAt` olarak yazılır. Yalnız bu
-- andan SONRA ilk görülen paketler otomatik hazırlanır.
--
-- İdempotent: anahtar zaten varsa DOKUNULMAZ. Başka hiçbir alan değişmez.
UPDATE "organization_settings"
SET "settings_json" = jsonb_set(
      "settings_json",
      '{autoLabel,producerFloorAt}',
      to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      true
    ),
    "updated_at" = now()
WHERE "settings_json" -> 'autoLabel' ->> 'enabled' = 'true'
  AND NOT (("settings_json" -> 'autoLabel') ? 'producerFloorAt');
