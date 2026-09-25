/** Optional physical design dimensions, used only to guide embroidery stitch scale. */
export function validateEmbroiderySize({ designWidthInches = '', designHeightInches = '' } = {}) {
  const fields = { designWidthInches, designHeightInches };
  const entries = Object.entries(fields).map(([key, value]) => [key, String(value ?? '').trim()]);
  const empty = entries.filter(([, value]) => !value).map(([key]) => key);
  if (empty.length === 2) return { width: null, height: null, error: '', invalidFields: [] };
  if (empty.length) return { error: 'Enter both width and height, or leave both blank.', invalidFields: empty };

  const invalid = entries.filter(([, value]) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)
    || !Number.isFinite(Number(value)) || Number(value) <= 0).map(([key]) => key);
  if (invalid.length) return { error: 'Enter a positive number in inches for each measurement.', invalidFields: invalid };

  const imprecise = entries.filter(([, value]) => {
    const digits = value.replace('.', '').replace(/^0+/, '');
    // Integer trailing zeros are placeholders; decimal trailing zeros express precision.
    return (value.includes('.') ? digits : digits.replace(/0+$/, '')).length > 3;
  }).map(([key]) => key);
  if (imprecise.length) return { error: 'Use up to 3 significant figures for each measurement.', invalidFields: imprecise };
  return { width: Number(designWidthInches), height: Number(designHeightInches), error: '', invalidFields: [] };
}
