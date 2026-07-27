import { isAnonymous, isAustralianMobile, toE164, toNationalDisplay } from './phone';

describe('toE164', () => {
  it.each([
    ['0412345678', '+61412345678'],
    ['0412 345 678', '+61412345678'],
    ['+61412345678', '+61412345678'],
    ['+61 412 345 678', '+61412345678'],
    ['(03) 9123 4567', '+61391234567'],
    ['03 9123 4567', '+61391234567'],
    ['  0412345678  ', '+61412345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['12345', 'too short'],
    ['not a phone number', 'non-numeric'],
  ])('returns null for %s (%s)', (input) => {
    expect(toE164(input)).toBeNull();
  });

  it('returns null rather than throwing for null and undefined', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
  });

  // A withheld caller ID arrives daily. It must be a null, not an exception —
  // the call still gets recorded, only the SMS is skipped.
  it.each(['anonymous', 'Anonymous', 'UNKNOWN', 'Private', 'restricted', 'withheld'])(
    'treats %s as a withheld caller ID',
    (input) => {
      expect(toE164(input)).toBeNull();
      expect(isAnonymous(input)).toBe(true);
    },
  );

  it('is idempotent — normalising an already-normalised number is a no-op', () => {
    const once = toE164('0412345678');
    expect(once).not.toBeNull();
    expect(toE164(once)).toBe(once);
  });
});

describe('isAnonymous', () => {
  it('is true for empty and nullish input', () => {
    expect(isAnonymous(null)).toBe(true);
    expect(isAnonymous(undefined)).toBe(true);
    expect(isAnonymous('')).toBe(true);
    expect(isAnonymous('   ')).toBe(true);
  });

  it('is false for a real number', () => {
    expect(isAnonymous('+61412345678')).toBe(false);
  });
});

describe('isAustralianMobile', () => {
  it('is true for an AU mobile', () => {
    expect(isAustralianMobile('+61412345678')).toBe(true);
  });

  // Landlines cost us a failed send and a Twilio 21614 if we text them.
  it('is false for an AU landline', () => {
    expect(isAustralianMobile('+61391234567')).toBe(false);
  });

  it('is false for a non-AU number', () => {
    expect(isAustralianMobile('+14155552671')).toBe(false);
  });
});

describe('toNationalDisplay', () => {
  it('formats an AU mobile for display', () => {
    expect(toNationalDisplay('+61412345678')).toBe('0412 345 678');
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(toNationalDisplay('nonsense')).toBe('nonsense');
  });
});
