import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'

// Harness dumanı: jsdom ortamı, React render'ı, gerçek tıklama ve testler
// arası DOM temizliği ÇALIŞIYOR mu? Ürün kodu test etmez.

function Probe({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" onClick={onPress}>
      harness
    </button>
  )
}

test('HARNESS-1: jsdom ortamı gerçek document sağlar', () => {
  expect(typeof document).toBe('object')
  expect(document.body).toBeTruthy()
})

test('HARNESS-2: React render + gerçek kullanıcı tıklaması çalışır', async () => {
  const user = userEvent.setup()
  let pressed = 0
  render(<Probe onPress={() => { pressed += 1 }} />)
  await user.click(screen.getByRole('button', { name: 'harness' }))
  expect(pressed).toBe(1)
})

test('HARNESS-3: testler arası DOM temizlenir (sızıntı yok)', () => {
  expect(screen.queryByRole('button', { name: 'harness' })).toBe(null)
})
