import "./vercelAnalytics";
import "./style.css";
import { SITE_FOOTER_HTML } from "./footer";

const root = document.getElementById("page-root");
if (root) {
  root.innerHTML = `
<div class="legal-layout">
  <header class="legal-top">
    <a href="/" class="legal-back">← Protected Left</a>
  </header>
  <main class="legal-main">
    <h1>Terms of Service</h1>
    <p class="legal-meta">Last updated: March 25, 2026</p>

    <p>
      These Terms of Service (“Terms”) govern your access to and use of the Protected Left website and any related services (collectively, the “Service”). By using the Service, you agree to these Terms. If you do not agree, do not use the Service.
    </p>

    <h2>1. The Service</h2>
    <p>
      Protected Left provides a map-based interface for experimenting with driving route suggestions. The Service relies on third-party data and routing engines (including, without limitation, OpenStreetMap-based geocoding, OSRM routing, and related APIs). Results may be incomplete, inaccurate, outdated, or unavailable. The Service is provided for general informational purposes only and is <strong>not</strong> a substitute for a dedicated in-vehicle navigation system, certified maps, or professional driving instruction.
    </p>

    <h2>2. Road signs, traffic control, and official directions take priority</h2>
    <p>
      <strong>All road signs, traffic signals, pavement markings, temporary traffic control devices, construction zones, and instructions from traffic enforcement, law enforcement, emergency responders, and other authorized traffic management personnel or entities always take absolute precedence over anything shown or suggested by this Service.</strong>
    </p>
    <p>
      You must <strong>not</strong> follow any route, maneuver, turn, speed, lane change, or other suggestion from this Service if it would conflict with—or cause you to disregard—any posted sign, signal, marking, local law, or direction from any authorized person or entity. You are solely responsible for driving safely and lawfully at all times.
    </p>

    <h2>3. No warranty</h2>
    <p>
      THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE,” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT ROUTES WILL BE SAFE, LEGAL, OR OPTIMAL FOR YOUR VEHICLE, CONDITIONS, OR JURISDICTION.
    </p>

    <h2>4. Limitation of liability</h2>
    <p>
      TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE OWNER, OPERATOR, DEVELOPER, CONTRIBUTORS, OR AFFILIATES OF THIS SERVICE (COLLECTIVELY, THE “OPERATORS”) BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICE, INCLUDING ANY ACCIDENT, VIOLATION, FINE, INJURY, DEATH, OR PROPERTY DAMAGE ALLEGEDLY RELATED TO RELIANCE ON THE SERVICE.
    </p>
    <p>
      TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE OPERATORS’ TOTAL LIABILITY FOR ANY CLAIMS ARISING OUT OF THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO USE THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR (B) ZERO DOLLARS ($0) IF THE SERVICE IS PROVIDED WITHOUT CHARGE.
    </p>
    <p>
      SOME JURISDICTIONS DO NOT ALLOW CERTAIN LIMITATIONS; IN THOSE JURISDICTIONS, THE OPERATORS’ LIABILITY IS LIMITED TO THE MAXIMUM EXTENT PERMITTED BY LAW.
    </p>

    <h2>5. Release and assumption of risk</h2>
    <p>
      You expressly acknowledge that driving and navigation involve inherent risks. You assume all risks associated with your use of the Service and your operation of a vehicle. To the fullest extent permitted by law, you <strong>release, waive, discharge, and covenant not to sue</strong> the Operators from any and all liability, claims, demands, actions, or causes of action arising out of or related to your use of the Service or reliance on any information it provides.
    </p>

    <h2>6. Indemnification</h2>
    <p>
      You agree to defend, indemnify, and hold harmless the Operators from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys’ fees) arising out of or related to your use of the Service, your violation of these Terms, or your violation of any law or third-party rights.
    </p>

    <h2>7. Third-party services</h2>
    <p>
      The Service integrates with or calls third-party services (such as map tiles, geocoding, routing, and payment links). Your use of those services may be subject to separate terms and privacy policies. The Operators are not responsible for third-party services’ availability, accuracy, or practices.
    </p>

    <h2>8. Donations</h2>
    <p>
      Optional donations may be processed by third-party payment providers (e.g., Stripe). Donations do not purchase navigation services, warranties, or support obligations beyond what is stated here.
    </p>

    <h2>9. Changes</h2>
    <p>
      The Operators may modify these Terms or the Service at any time. Continued use after changes constitutes acceptance of the updated Terms.
    </p>

    <h2>10. Governing law</h2>
    <p>
      These Terms are governed by the laws applicable in your jurisdiction only to the minimum extent required; if any provision is unenforceable, the remaining provisions remain in effect.
    </p>

    <h2>11. Contact</h2>
    <p>
      For questions about these Terms, use the contact or support channel provided by the site operator, if any.
    </p>
  </main>
  ${SITE_FOOTER_HTML}
</div>
`;
}
