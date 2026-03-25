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
    <h1>About Protected Left</h1>
    <p class="legal-lead">
      <strong>Protected Left</strong> is a web-based map tool that helps you plan a driving route between a starting point and a destination. It requests several route options from a public routing engine and prefers the option with the <em>fewest left turns</em> (including slight lefts and U-turns in the turn-by-turn data), as a practical way to reduce exposure to risky unprotected left turns. It does <strong>not</strong> know which intersections have dedicated “protected” left-turn signal phases—that information is generally not available in public map data.
    </p>

    <h2>How it works</h2>
    <ul>
      <li>You enter a start and destination (or use your device location for the start). Addresses are resolved using open geocoding services.</li>
      <li>The app asks the <a href="https://project-osrm.org/" target="_blank" rel="noopener noreferrer">OSRM</a> public demo for multiple driving routes when possible.</li>
      <li>It compares those routes using turn instructions and picks one with the minimum number of leftward maneuvers, with ties broken by shorter estimated travel time and distance.</li>
      <li>You can drag map pins to fine-tune locations; the route is computed from the pin positions you set.</li>
    </ul>

    <h2>Data &amp; services</h2>
    <p>
      Search and suggestions use <strong>Photon</strong> (Komoot), built on <strong>OpenStreetMap</strong> data. When needed, fallback geocoding uses <strong>Nominatim</strong> (OpenStreetMap). Map tiles are from OpenStreetMap contributors. Routing uses the OSRM demo service. These are third-party services with their own availability, accuracy, and usage policies.
    </p>

    <h2>How it was built</h2>
    <p>
      The site is a client-side application built with <strong>Vite</strong>, <strong>TypeScript</strong>, and <strong>Leaflet</strong> for the map. It runs entirely in your browser (aside from calls to the geocoding and routing endpoints you configure). It is not a commercial navigation product and is provided for informational purposes only.
    </p>

    <p class="legal-note">
      Always obey posted signs, signals, road markings, and directions from law enforcement and traffic authorities. See our <a href="/terms.html">Terms of Service</a> for important limitations.
    </p>
  </main>
  ${SITE_FOOTER_HTML}
</div>
`;
}
