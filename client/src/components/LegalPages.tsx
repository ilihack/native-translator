/**
 * Full-screen overlay components for legal content: Privacy Policy (Datenschutz) and Imprint (Impressum).
 * Renders dismissible modal panels with formatted legal text; includes GDPR Art. 20/21 rights,
 * named supervisory authority (RLP), Replit hosting details, EU-US DPF, and 16+ age restriction.
 * @inputs isVisible boolean, onClose callback
 * @exports ImpressumPage, DatenschutzPage functional components
 */
import { FC } from 'react';
import { X } from 'lucide-react';

interface LegalPageProps {
  isVisible: boolean;
  onClose: () => void;
}

export const ImpressumPage: FC<LegalPageProps> = ({ isVisible, onClose }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/95 backdrop-blur-md flex flex-col items-center animate-in fade-in duration-200 overflow-y-auto">
      <div className="w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-white">Legal Notice / Impressum</h1>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors"
            data-testid="button-close-impressum"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="space-y-6 text-zinc-300 text-sm">
          <section>
            <h2 className="text-lg font-bold text-white mb-2">Information according to § 5 DDG (German Digital Services Act)</h2>
            <p>Ilyas Demir</p>
            <p>Rosenstraße 15</p>
            <p>67063 Ludwigshafen am Rhein, Germany</p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">Contact</h2>
            <p>Email: ilyasde+iiT@gmail.com</p>
            <p className="text-zinc-400 mt-1">
              Website: <span className="text-zinc-300">nativtranslator.app</span>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">Responsible for Content (§ 55 MStV)</h2>
            <p>Ilyas Demir</p>
            <p>Rosenstraße 15</p>
            <p>67063 Ludwigshafen am Rhein, Germany</p>
          </section>

          <section className="bg-zinc-900 rounded-lg p-4 border border-amber-700/50">
            <h2 className="text-base font-bold text-amber-400 mb-2">Age Restriction / Altersbeschränkung</h2>
            <p className="text-zinc-300">
              This application is intended for users aged{' '}
              <strong className="text-white">16 years or older</strong> (Art. 8 GDPR).
              By using this app, you confirm that you are at least 16 years of age.
            </p>
            <p className="text-zinc-500 mt-2 text-xs">
              Diese Anwendung richtet sich an Nutzer ab{' '}
              <strong className="text-zinc-400">16 Jahren</strong> (Art. 8 DSGVO).
              Mit der Nutzung bestätigen Sie, mindestens 16 Jahre alt zu sein.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">AI Translation Disclaimer</h2>
            <p className="text-zinc-400">
              AI-generated translations may contain errors. This application must not be used for
              medical, legal, safety-critical, or professional purposes. Do not rely on translations
              for life-altering decisions.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">Liability for Links</h2>
            <p className="text-zinc-400">
              This application is provided as-is. Despite careful content control, I assume no
              liability for the content of external links. The operators of linked pages are solely
              responsible for their content.
            </p>
          </section>
        </div>

        <button
          onClick={onClose}
          className="mt-8 w-full py-3 bg-zinc-800 text-white font-bold rounded-lg hover:bg-zinc-700 transition-colors"
          data-testid="button-back-from-impressum"
        >
          Back
        </button>
      </div>
    </div>
  );
};

export const DatenschutzPage: FC<LegalPageProps> = ({ isVisible, onClose }) => {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/95 backdrop-blur-md flex flex-col items-center animate-in fade-in duration-200 overflow-y-auto">
      <div className="w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-white">Privacy Policy / Datenschutzerklärung</h1>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition-colors"
            data-testid="button-close-datenschutz"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="space-y-6 text-zinc-300 text-sm">

          <section>
            <h2 className="text-lg font-bold text-white mb-2">1. Data Controller (Verantwortlicher)</h2>
            <p>
              Ilyas Demir<br />
              Rosenstraße 15<br />
              67063 Ludwigshafen am Rhein, Germany<br />
              Email: ilyasde+iiT@gmail.com
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">2. Overview of Data Processing</h2>
            <p className="text-zinc-400">
              Native Translator is a client-side Progressive Web App. Voice audio is streamed directly
              from your browser to Google's Gemini Live API for real-time translation.{' '}
              <strong className="text-zinc-200">No audio, translation text, or personal data is stored on our servers.</strong>{' '}
              The app does not require account registration.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">3. Audio Processing by Third Parties</h2>
            <p className="text-zinc-400">
              Your voice audio is transmitted in real time to{' '}
              <strong className="text-zinc-200">Google LLC</strong>
              {' '}(1600 Amphitheatre Parkway, Mountain View, CA 94043, USA) and processed via the
              Gemini Live API to generate translations and spoken responses. Google may use this data
              in accordance with its own privacy policy.
            </p>
            <p className="text-zinc-400 mt-2">
              <strong className="text-zinc-200">Legal basis:</strong>{' '}
              Art. 6(1)(b) GDPR (service performance) and Art. 6(1)(a) GDPR (consent given at first launch).
            </p>
            <p className="text-zinc-400 mt-2">
              Google's privacy policy:{' '}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                policies.google.com/privacy
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">4. International Data Transfers — EU-US Data Privacy Framework</h2>
            <p className="text-zinc-400">
              Google LLC is certified under the{' '}
              <strong className="text-zinc-200">EU-US Data Privacy Framework (DPF)</strong>, recognised
              by the European Commission as providing an adequate level of data protection
              (Implementing Decision (EU) 2023/1795 of 10 July 2023, Art. 45 GDPR).
              Audio data transmitted to the Gemini API is therefore transferred on the basis of this
              adequacy decision. For transfers not covered by DPF, Standard Contractual Clauses (SCCs)
              pursuant to Art. 46(2)(c) GDPR apply.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">5. API Key &amp; Settings Storage</h2>
            <p className="text-zinc-400">
              Your Gemini API key and app settings (language selection, voice, audio preferences) are
              stored <strong className="text-zinc-200">only in your browser's localStorage</strong> on
              your device. This data never leaves your device to our servers.
              Legal basis: Art. 6(1)(f) GDPR (legitimate interest in providing a functional experience).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">6. Storage Duration</h2>
            <p className="text-zinc-400">
              Local data (API key, settings) remain in your browser until you delete them or clear
              browser storage. Server log files created by our hosting provider are retained for{' '}
              <strong className="text-zinc-200">up to 7 days</strong> and then automatically deleted.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">7. Your Rights under GDPR</h2>
            <p className="text-zinc-400">You have the following rights (contact us at the address in section 1):</p>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-2">
              <li>Right of access (Art. 15 GDPR)</li>
              <li>Right to rectification (Art. 16 GDPR)</li>
              <li>Right to erasure (Art. 17 GDPR)</li>
              <li>Right to restriction of processing (Art. 18 GDPR)</li>
              <li>Right to data portability (Art. 20 GDPR)</li>
              <li>
                Right to object (Art. 21 GDPR) — you may object at any time to processing based on
                Art. 6(1)(f); we will then no longer process your data unless we demonstrate compelling
                legitimate grounds overriding your interests
              </li>
              <li>
                Right to withdraw consent (Art. 7(3) GDPR) — withdrawal does not affect the
                lawfulness of prior processing
              </li>
              <li>Right to lodge a complaint with a supervisory authority (Art. 77 GDPR)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">8. Supervisory Authority (Aufsichtsbehörde)</h2>
            <p className="text-zinc-400">The competent supervisory authority is:</p>
            <p className="text-zinc-300 mt-2 leading-relaxed">
              Landesbeauftragte für den Datenschutz<br />
              und die Informationsfreiheit Rheinland-Pfalz<br />
              Hintere Bleiche 34<br />
              55116 Mainz, Germany<br />
              Phone: +49 6131 8920-0<br />
              <a
                href="https://www.datenschutz.rlp.de"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                www.datenschutz.rlp.de
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">9. Hosting</h2>
            <p className="text-zinc-400">
              This application is hosted by{' '}
              <strong className="text-zinc-200">Replit Inc.</strong>
              {' '}(600 3rd Street, San Francisco, CA 94107, USA).
              When you access the website, the hosting provider automatically creates server log files
              which may include your IP address, browser type, operating system, referrer URL, and
              access time.{' '}
              <strong className="text-zinc-200">Server logs are retained for up to 7 days</strong>{' '}
              and then deleted. This processing is based on Replit's legitimate interest in operating
              a secure and reliable infrastructure (Art. 6(1)(f) GDPR).
            </p>
            <p className="text-zinc-400 mt-2">
              Replit's privacy policy:{' '}
              <a
                href="https://replit.com/site/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline"
              >
                replit.com/site/privacy
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">10. SSL/TLS Encryption</h2>
            <p className="text-zinc-400">
              All data transmitted between your browser and our server is encrypted using SSL/TLS.
              You can recognise an encrypted connection by "https://" in your browser's address bar.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-white mb-2">11. Age Restriction</h2>
            <p className="text-zinc-400">
              This application is intended for users aged{' '}
              <strong className="text-zinc-200">16 years or older</strong> (Art. 8 GDPR).
              We do not knowingly process data from children under 16. If you believe a child under
              16 has used this service, please contact us immediately so we can take appropriate action.
            </p>
          </section>

          <section className="border-t border-zinc-800 pt-4">
            <p className="text-zinc-500 text-xs">
              Last updated: March 2026 · nativtranslator.app
            </p>
          </section>
        </div>

        <button
          onClick={onClose}
          className="mt-8 w-full py-3 bg-zinc-800 text-white font-bold rounded-lg hover:bg-zinc-700 transition-colors"
          data-testid="button-back-from-datenschutz"
        >
          Back
        </button>
      </div>
    </div>
  );
};
