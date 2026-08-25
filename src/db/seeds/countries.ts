import type { Continent } from '../schema/countries';

/**
 * ISO 3166-1 alpha-2 → continent, for the referral competition.
 *
 * Only the six habitable continents exist, so Antarctica (AQ) and the
 * uninhabited territories around it are deliberately absent — a signup that
 * geolocates there resolves to no continent and scores nothing, which is the
 * intended behaviour rather than an omission.
 *
 * Where a country straddles a conventional boundary the assignment is a
 * judgement call, and it is a scoring-relevant one: it decides whether a
 * referral pays 10 points or 20. The choices made here follow the UN geoscheme
 * as the least surprising available convention — notably Russia and Turkey to
 * Europe, Cyprus to Europe, and the transcontinental Caucasus states to Asia.
 * Anyone changing one of these is changing the rules of the competition, not
 * fixing a data error.
 */

const BY_CONTINENT: Record<Continent, Record<string, string>> = {
  AF: {
    DZ: 'Algeria', AO: 'Angola', BJ: 'Benin', BW: 'Botswana', BF: 'Burkina Faso',
    BI: 'Burundi', CV: 'Cabo Verde', CM: 'Cameroon', CF: 'Central African Republic',
    TD: 'Chad', KM: 'Comoros', CG: 'Congo', CD: 'Congo (DRC)', CI: "Côte d'Ivoire",
    DJ: 'Djibouti', EG: 'Egypt', GQ: 'Equatorial Guinea', ER: 'Eritrea',
    SZ: 'Eswatini', ET: 'Ethiopia', GA: 'Gabon', GM: 'Gambia', GH: 'Ghana',
    GN: 'Guinea', GW: 'Guinea-Bissau', KE: 'Kenya', LS: 'Lesotho', LR: 'Liberia',
    LY: 'Libya', MG: 'Madagascar', MW: 'Malawi', ML: 'Mali', MR: 'Mauritania',
    MU: 'Mauritius', YT: 'Mayotte', MA: 'Morocco', MZ: 'Mozambique', NA: 'Namibia',
    NE: 'Niger', NG: 'Nigeria', RE: 'Réunion', RW: 'Rwanda', SH: 'Saint Helena',
    ST: 'São Tomé and Príncipe', SN: 'Senegal', SC: 'Seychelles', SL: 'Sierra Leone',
    SO: 'Somalia', ZA: 'South Africa', SS: 'South Sudan', SD: 'Sudan',
    TZ: 'Tanzania', TG: 'Togo', TN: 'Tunisia', UG: 'Uganda', EH: 'Western Sahara',
    ZM: 'Zambia', ZW: 'Zimbabwe',
  },
  EU: {
    AL: 'Albania', AD: 'Andorra', AT: 'Austria', AX: 'Åland Islands', BY: 'Belarus',
    BE: 'Belgium', BA: 'Bosnia and Herzegovina', BG: 'Bulgaria', HR: 'Croatia',
    CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia', FO: 'Faroe Islands',
    FI: 'Finland', FR: 'France', DE: 'Germany', GI: 'Gibraltar', GR: 'Greece',
    GG: 'Guernsey', HU: 'Hungary', IS: 'Iceland', IE: 'Ireland', IM: 'Isle of Man',
    IT: 'Italy', JE: 'Jersey', XK: 'Kosovo', LV: 'Latvia', LI: 'Liechtenstein',
    LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', MD: 'Moldova', MC: 'Monaco',
    ME: 'Montenegro', NL: 'Netherlands', MK: 'North Macedonia', NO: 'Norway',
    PL: 'Poland', PT: 'Portugal', RO: 'Romania', RU: 'Russia', SM: 'San Marino',
    RS: 'Serbia', SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain',
    SJ: 'Svalbard and Jan Mayen', SE: 'Sweden', CH: 'Switzerland', TR: 'Türkiye',
    UA: 'Ukraine', GB: 'United Kingdom', VA: 'Vatican City',
  },
  AS: {
    AF: 'Afghanistan', AM: 'Armenia', AZ: 'Azerbaijan', BH: 'Bahrain',
    BD: 'Bangladesh', BT: 'Bhutan', BN: 'Brunei', KH: 'Cambodia', CN: 'China',
    GE: 'Georgia', HK: 'Hong Kong', IN: 'India', ID: 'Indonesia', IR: 'Iran',
    IQ: 'Iraq', IL: 'Israel', JP: 'Japan', JO: 'Jordan', KZ: 'Kazakhstan',
    KW: 'Kuwait', KG: 'Kyrgyzstan', LA: 'Laos', LB: 'Lebanon', MO: 'Macao',
    MY: 'Malaysia', MV: 'Maldives', MN: 'Mongolia', MM: 'Myanmar', NP: 'Nepal',
    KP: 'North Korea', OM: 'Oman', PK: 'Pakistan', PS: 'Palestine',
    PH: 'Philippines', QA: 'Qatar', SA: 'Saudi Arabia', SG: 'Singapore',
    KR: 'South Korea', LK: 'Sri Lanka', SY: 'Syria', TW: 'Taiwan',
    TJ: 'Tajikistan', TH: 'Thailand', TL: 'Timor-Leste', TM: 'Turkmenistan',
    AE: 'United Arab Emirates', UZ: 'Uzbekistan', VN: 'Vietnam', YE: 'Yemen',
  },
  NA: {
    AI: 'Anguilla', AG: 'Antigua and Barbuda', AW: 'Aruba', BS: 'Bahamas',
    BB: 'Barbados', BZ: 'Belize', BM: 'Bermuda', BQ: 'Caribbean Netherlands',
    VG: 'British Virgin Islands', CA: 'Canada', KY: 'Cayman Islands',
    CR: 'Costa Rica', CU: 'Cuba', CW: 'Curaçao', DM: 'Dominica',
    DO: 'Dominican Republic', SV: 'El Salvador', GL: 'Greenland', GD: 'Grenada',
    GP: 'Guadeloupe', GT: 'Guatemala', HT: 'Haiti', HN: 'Honduras', JM: 'Jamaica',
    MQ: 'Martinique', MX: 'Mexico', MS: 'Montserrat', NI: 'Nicaragua',
    PA: 'Panama', PR: 'Puerto Rico', BL: 'Saint Barthélemy',
    KN: 'Saint Kitts and Nevis', LC: 'Saint Lucia', MF: 'Saint Martin',
    PM: 'Saint Pierre and Miquelon', VC: 'Saint Vincent and the Grenadines',
    SX: 'Sint Maarten', TT: 'Trinidad and Tobago', TC: 'Turks and Caicos Islands',
    US: 'United States', VI: 'U.S. Virgin Islands',
  },
  SA: {
    AR: 'Argentina', BO: 'Bolivia', BR: 'Brazil', CL: 'Chile', CO: 'Colombia',
    EC: 'Ecuador', FK: 'Falkland Islands', GF: 'French Guiana', GY: 'Guyana',
    PY: 'Paraguay', PE: 'Peru', SR: 'Suriname', UY: 'Uruguay', VE: 'Venezuela',
  },
  OC: {
    AS: 'American Samoa', AU: 'Australia', CK: 'Cook Islands', FJ: 'Fiji',
    PF: 'French Polynesia', GU: 'Guam', KI: 'Kiribati', MH: 'Marshall Islands',
    FM: 'Micronesia', NR: 'Nauru', NC: 'New Caledonia', NZ: 'New Zealand',
    NU: 'Niue', NF: 'Norfolk Island', MP: 'Northern Mariana Islands', PW: 'Palau',
    PG: 'Papua New Guinea', PN: 'Pitcairn Islands', WS: 'Samoa',
    SB: 'Solomon Islands', TK: 'Tokelau', TO: 'Tonga', TV: 'Tuvalu',
    VU: 'Vanuatu', WF: 'Wallis and Futuna',
  },
};

export interface CountrySeedRow {
  code: string;
  name: string;
  continent: Continent;
}

export const COUNTRY_SEED: CountrySeedRow[] = Object.entries(BY_CONTINENT).flatMap(
  ([continent, members]) =>
    Object.entries(members).map(([code, name]) => ({
      code,
      name,
      continent: continent as Continent,
    })),
);
