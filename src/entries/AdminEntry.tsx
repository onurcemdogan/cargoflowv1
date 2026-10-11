// PLATFORM YÖNETİCİ GİRİŞİ (/admin*). AdminApp DEĞİŞMEDİ; organizasyon
// AuthProvider'ından ayrı ağaçtır. Tembel yüklenir.
import { useEffect } from 'react'
import '../index.css'
import { AdminApp } from '../admin/AdminApp.tsx'
import { ADMIN_TITLE } from '../entryRoute.ts'

export default function AdminEntry() {
  useEffect(() => {
    document.title = ADMIN_TITLE
  }, [])
  return <AdminApp />
}
