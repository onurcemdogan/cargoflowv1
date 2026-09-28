// ARAS — paylaşılan SOAP 1.1 kaçış ve zarf iskeleti (taşıma katmanı).

export function escapeArasXml(value: unknown): string {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&apos;')
}

const ENVELOPE_OPEN = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
    + ' xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
  '  <soap:Body>',
].join('\n')

const ENVELOPE_CLOSE = [
  '  </soap:Body>',
  '</soap:Envelope>',
].join('\n')

export function buildArasSoap11Envelope(
  operationElement: string,
  innerBodyLines: string[],
): string {
  return [
    ENVELOPE_OPEN,
    `    <${operationElement} xmlns="http://tempuri.org/">`,
    ...innerBodyLines,
    `    </${operationElement}>`,
    ENVELOPE_CLOSE,
  ].join('\n')
}
