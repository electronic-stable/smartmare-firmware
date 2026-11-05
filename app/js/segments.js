/*
 * SmartMare 5V - 7-segment LED display
 *
 * Fabien Roffet for Electronic Stable - smartmare.com
 * Version 1.2.8 - 5 Nov 2026
 * SPDX-License-Identifier: MIT
 */
/* A red 7-segment LED display, drawn in SVG. */
"use strict";

const Segments = (() => {
  //            a  b  c  d  e  f  g
  const MAP = {
    "0": "1111110", "1": "0110000", "2": "1101101", "3": "1111001", "4": "0110011",
    "5": "1011011", "6": "1011111", "7": "1110000", "8": "1111111", "9": "1111011",
    "-": "0000001", " ": "0000000", "_": "0001000",
    A: "1110111", b: "0011111", C: "1001110", c: "0001101", d: "0111101", E: "1001111",
    F: "1000111", H: "0110111", h: "0010111", L: "0001110", n: "0010101", o: "0011101",
    P: "1100111", r: "0000101", t: "0001111", U: "0111110", u: "0011100", y: "0111011",
    S: "1011011", I: "0110000", J: "0111000",
  };
  // Segment polygons in a 40 x 70 cell (a, b, c, d, e, f, g).
  const SEG = [
    "8,4 32,4 28,9 12,9", "33,6 33,33 29,30 29,10", "33,37 33,64 29,60 29,40",
    "8,66 32,66 28,61 12,61", "7,37 7,64 11,60 11,40", "7,6 7,33 11,30 11,10",
    "9,35 13,31 27,31 31,35 27,39 13,39",
  ];

  function render(el, text, dots = []) {
    const chars = String(text).padStart(3, " ").slice(-3).split("");
    let svg = `<svg viewBox="0 0 ${chars.length * 46} 74" xmlns="http://www.w3.org/2000/svg">`;
    chars.forEach((c, i) => {
      const bits = MAP[c] ?? MAP[c.toUpperCase()] ?? MAP[c.toLowerCase()] ?? MAP[" "];
      svg += `<g transform="translate(${i * 46 + 2} 2) skewX(-6)">`;
      SEG.forEach((p, k) => { svg += `<polygon points="${p}" class="${bits[k] === "1" ? "on" : "off"}"/>`; });
      svg += `<circle cx="39" cy="66" r="3" class="${dots[i] ? "on" : "off"}"/></g>`;
    });
    el.innerHTML = svg + "</svg>";
  }
  return { render };
})();
