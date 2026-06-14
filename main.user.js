// ==UserScript==
// @name	CMU Course Labels
// @namespace	http://tampermonkey.net/
// @version	0.1
// @match	*://*.cmu.edu/*
// @match	*://cmu.edu/*
// @match	*://discord.com/channels/1429981529123324037/*
// @grant	none
// @run-at	document-idle
// ==/UserScript==

(function () {
	'use strict';

	// Finds candidate CMU course codes in two forms:
	//   xx-xxx   e.g. 15-122
	//   xxxxx    e.g. 15122  (exactly five digits)
	// Whether a candidate is actually accepted is decided by isStandaloneWord(),
	// which enforces the strict "complete word" boundary rules.
	const COURSE_RE = /(\d{2}-\d{3}|\d{5})/g;

	// Tags whose text we never want to touch.
	const SKIP_TAGS = new Set([
		'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
		'SELECT', 'OPTION', 'CODE', 'PRE'
	]);

	// Marker class so we never re-process our own inserted nodes.
	const PROCESSED_ATTR = 'data-cmu-course-label';

	// Course catalog search URL. The ?P= parameter must use the hyphenated
	// xx-xxx form, so a five-digit code gets a hyphen inserted.
	const CATALOG_URL = 'http://coursecatalog.web.cmu.edu/search/?P=';

	/**
	 * Returns the hyphenated xx-xxx form of a code (e.g. 15122 -> 15-122).
	 */
	function hyphenate(code) {
		return code.indexOf('-') !== -1 ? code : code.slice(0, 2) + '-' + code.slice(2);
	}

	/**
	 * Deterministic string -> hue (0-359) hash, so each major always gets the
	 * same, distinct colour. Uses FNV-1a plus a bit-mixing finalizer so that
	 * near-identical short inputs (e.g. "15" vs "16") produce very different
	 * hues instead of adjacent ones. Lightness/saturation are fixed in CSS.
	 */
	function hashHue(str) {
		let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
		for (let i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = Math.imul(h, 0x01000193); // FNV prime
		}
		// xorshift / multiply finalizer for strong avalanche
		h ^= h >>> 16;
		h = Math.imul(h, 0x7feb352d);
		h ^= h >>> 15;
		h = Math.imul(h, 0x846ca68b);
		h ^= h >>> 16;
		return (h >>> 0) % 360;
	}

	/**
	 * Injects the badge stylesheet once. The major segment's colour is supplied
	 * per-element via the --major-hue custom property (set from hashHue()).
	 */
	function injectStyles() {
		if (document.getElementById('cmu-course-style')) return;
		const style = document.createElement('style');
		style.id = 'cmu-course-style';
		style.textContent = `
			.cmu-course {
				display: inline-flex;
				align-items: stretch;
				vertical-align: middle;
				margin: 0 2px;
				border-radius: 0px;
				border: none !important;
				overflow: hidden;
				font: 600 0.75em/1.6 "Open Sans", Helvetica, sans-serif;
				text-decoration: none !important;
				white-space: nowrap;
				cursor: pointer;
				padding: 0 !important;
			}
			.cmu-course:hover { opacity: 0.8; }
			.cmu-course-seg {
				padding: 0 4px;
				color: #fff !important;
			}
			.cmu-course-major {
				background-color: hsl(var(--major-hue, 0), 58%, 42%);
			}
			.cmu-course-prefix { background-color: #36404a; }
			.cmu-course-number { background-color: #5b6b78; }
		`;
		(document.head || document.documentElement).appendChild(style);
	}

	// Maps the two-digit subject prefix to ["short abbreviation", "original name"].
	// The short form is what gets displayed; the original is kept for reference.
	// Prefixes that are unused (the official name is just the number itself)
	// are intentionally omitted, so they get no major label.
	const MAJORS = {
		'02': ['CompBio', 'Computational Biology'],
		'03': ['Bio', 'Biological Sciences'],
		'04': ['ICT', 'Information & Communication Technology'],
		'05': ['HCI', 'Human-Computer Interaction'],
		'06': ['ChemE', 'Chemical Engineering'],
		'07': ['SCS', 'SCS Interdisciplinary'],
		'08': ['ISR', 'Institute for Software Research'],
		'09': ['Chem', 'Chemistry'],
		'10': ['ML', 'Machine Learning'],
		'11': ['LTI', 'Language Technologies Institute'],
		'12': ['CEE', 'Civil & Environmental Engineering'],
		'14': ['INI', 'Information Networking Institute'],
		'15': ['CS', 'Computer Science'],
		'16': ['Robotics', 'Robotics'],
		'17': ['SWE', 'Software Engineering'],
		'18': ['ECE', 'Electrical & Computer Engineering'],
		'19': ['EPP', 'Engineering & Public Policy'],
		'21': ['Math', 'Mathematical Sciences'],
		'24': ['MechE', 'Mechanical Engineering'],
		'27': ['MSE', 'Materials Science & Engineering'],
		'30': ['MilSci', 'Military Science - ROTC'],
		'31': ['AeroStudies', 'Aerospace Studies - ROTC'],
		'32': ['NavSci', 'Naval Science - ROTC'],
		'33': ['Phys', 'Physics'],
		'36': ['Stats', 'Statistics'],
		'38': ['MCS', 'MCS Interdisciplinary'],
		'39': ['CIT', 'CIT Interdisciplinary'],
		'42': ['BME', 'Biomedical Engineering'],
		'45': ['Tepper', 'Tepper School of Business'],
		'46': ['Tepper', 'Tepper School of Business'],
		'47': ['Tepper', 'Tepper School of Business'],
		'48': ['Arch', 'Architecture'],
		'49': ['III', 'Integrated Innovation Institute'],
		'51': ['Design', 'Design'],
		'52': ['BXA', 'BXA Intercollege Degree Programs'],
		'53': ['ETC', 'Entertainment Technology Pittsburgh'],
		'54': ['Drama', 'Drama'],
		'57': ['Music', 'Music'],
		'60': ['Art', 'Art'],
		'62': ['CFA', 'CFA Interdisciplinary'],
		'64': ['CAS', 'Center for the Arts in Society'],
		'65': ['DC', 'General Dietrich College'],
		'66': ['DC', 'Dietrich College Interdisciplinary'],
		'67': ['DC/IS', 'Dietrich College Information Systems'],
		'69': ['PhysEd', 'Physical Education'],
		'70': ['BusAdmin', 'Business Administration'],
		'73': ['Econ', 'Economics'],
		'76': ['Eng', 'English'],
		'79': ['Hist', 'History'],
		'80': ['Phil', 'Philosophy'],
		'82': ['ModLang', 'Modern Languages'],
		'84': ['IPS', 'Institute for Politics and Strategy'],
		'85': ['Psych', 'Psychology'],
		'86': ['CNBC', 'Center for the Neural Basis of Cognition'],
		'88': ['SDS', 'Social & Decision Sciences'],
		'90': ['Heinz/PPM', 'Public Policy & Mgt:Sch of Pub Pol & Mgt'],
		'93': ['Heinz/CE', 'Creative Enterprise:Sch of Pub Pol & Mgt'],
		'94': ['Heinz', 'Heinz College Wide Courses'],
		'95': ['Heinz/IS', 'Information Systems:Sch of IS & Mgt'],
		'96': ['SV', 'Silicon Valley'],
		'98': ['StuCo', 'StuCo (Student Led Courses)'],
		'99': ['CMU-Wide', 'Carnegie Mellon University-Wide Studies']
	};

	/**
	 * The first two digits of a course code identify the major / department.
	 * Returns those two digits for a given code (handles both xx-xxx and xxxxx).
	 */
	function majorPrefix(code) {
		return code.slice(0, 2);
	}

	/**
	 * Strict "complete word" test for a candidate match spanning [start, end)
	 * within the text node string `text`. A code is accepted only when each
	 * side is one of the following; anything else (commas, parens, colons,
	 * slashes, letters, digits, a mid-string period, etc.) rejects it:
	 *   - left:  the beginning of the element (text node) OR a whitespace char
	 *            OR an opening parenthesis directly before the code
	 *   - right: the end of the element (text node) OR a whitespace char
	 *            OR a closing parenthesis directly after the code
	 *            OR a single period that is the final character or is itself
	 *            followed by whitespace (so "15-122." at the end and
	 *            "15-122. Next sentence" are both allowed, but "15-122.foo"
	 *            is not).
	 */
	function isStandaloneWord(text, start, end) {
		const before = text[start - 1];
		const leftOK = start === 0 || /\s/.test(before) || before === '(';
		if (!leftOK) return false;

		if (end === text.length) return true;            // end of element
		const after = text[end];
		if (/\s/.test(after)) return true;                // followed by a space
		if (after === ')') return true;                   // closing parenthesis
		if (".,:;".includes(after) && (end + 1 === text.length || /\s/.test(text[end + 1]))) {
			return true;                                  // trailing period at end or before whitespace
		}
		return false;
	}

	/**
	 * Returns true if the given text node should be skipped because it lives
	 * inside a link, an editable region, or one of the SKIP_TAGS.
	 */
	function shouldSkip(node) {
		for (let el = node.parentElement; el; el = el.parentElement) {
			if (SKIP_TAGS.has(el.tagName)) return true;
			if (el.isContentEditable) return true;
			if (el.hasAttribute(PROCESSED_ATTR)) return true;
		}
		return false;
	}

	/**
	 * Builds the wrapper element for a single detected course code.
	 * When `insideLink` is false the whole label becomes a link to the catalog
	 * (using the hyphenated xx-xxx form); if it is already inside a link we use
	 * a plain span instead so we never nest <a> elements.
	 */
	function buildLabel(code, insideLink) {
		const wrap = document.createElement(insideLink ? 'span' : 'a');
		wrap.setAttribute(PROCESSED_ATTR, '');
		wrap.className = 'cmu-course';
		if (!insideLink) {
			wrap.href = CATALOG_URL + hyphenate(code);
		}

		const prefix = majorPrefix(code);            // "15"
		const number = hyphenate(code).slice(3);     // "122"

		// Major segment, coloured by a hash of its prefix. Unknown / unused
		// prefixes get no major segment at all.
		const major = MAJORS[prefix];
		if (major) {
			const [shortName, originalName] = major;
			const majorSeg = document.createElement('span');
			majorSeg.className = 'cmu-course-seg cmu-course-major';
			majorSeg.dataset.majorPrefix = prefix;
			majorSeg.dataset.majorName = originalName;
			majorSeg.title = originalName; // hover tooltip showing the full name
			majorSeg.style.setProperty('--major-hue', hashHue(prefix));
			majorSeg.textContent = shortName;
			wrap.appendChild(majorSeg);
		}

		// Subject number (xx) segment.
		const prefixSeg = document.createElement('span');
		prefixSeg.className = 'cmu-course-seg cmu-course-prefix';
		prefixSeg.textContent = prefix;
		wrap.appendChild(prefixSeg);

		// Course number (xxx) segment.
		const numberSeg = document.createElement('span');
		numberSeg.className = 'cmu-course-seg cmu-course-number';
		numberSeg.textContent = number;
		wrap.appendChild(numberSeg);

		return wrap;
	}

	/**
	 * Processes a single text node, replacing any course codes with labelled
	 * wrapper elements. Does nothing if no codes are present.
	 */
	function processTextNode(node) {
		const text = node.nodeValue;
		if (!text || text.length < 5) return;

		COURSE_RE.lastIndex = 0;
		if (!COURSE_RE.test(text)) return;

		// A code already inside an <a> must not be re-linked (no nested anchors).
		const insideLink = !!(node.parentElement && node.parentElement.closest('a'));

		COURSE_RE.lastIndex = 0;
		const frag = document.createDocumentFragment();
		let lastIndex = 0;
		let match;
		let madeLabel = false;

		while ((match = COURSE_RE.exec(text)) !== null) {
			const start = match.index;
			const code = match[0];
			const end = start + code.length;

			// Skip candidates that aren't a standalone "complete word"; they stay
			// as plain text (folded into a later slice).
			if (!isStandaloneWord(text, start, end)) continue;

			if (start > lastIndex) {
				frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
			}
			frag.appendChild(buildLabel(code, insideLink));
			lastIndex = end;
			madeLabel = true;
		}

		// Nothing qualified — leave the text node untouched.
		if (!madeLabel) return;

		if (lastIndex < text.length) {
			frag.appendChild(document.createTextNode(text.slice(lastIndex)));
		}

		node.parentNode.replaceChild(frag, node);
	}

	/**
	 * Walks the subtree rooted at `root`, collecting then processing all
	 * eligible text nodes. Collecting first avoids mutating the tree while
	 * the TreeWalker is iterating over it.
	 */
	function scan(root) {
		if (!root) return;
		if (root.nodeType === Node.TEXT_NODE) {
			if (!shouldSkip(root)) processTextNode(root);
			return;
		}
		if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
			return;
		}

		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode(n) {
				return shouldSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			}
		});

		const nodes = [];
		let n;
		while ((n = walker.nextNode())) nodes.push(n);
		nodes.forEach(processTextNode);
	}

	// Inject the badge styles, then do the initial pass over the whole document.
	injectStyles();
	scan(document.body);

	// Watch for dynamically added / changed content and process it too.
	const observer = new MutationObserver((mutations) => {
		for (const m of mutations) {
			if (m.type === 'childList') {
				m.addedNodes.forEach(scan);
			} else if (m.type === 'characterData') {
				const node = m.target;
				if (node.nodeType === Node.TEXT_NODE && !shouldSkip(node)) {
					processTextNode(node);
				}
			}
		}
	});

	observer.observe(document.body, {
		childList: true,
		subtree: true,
		characterData: true
	});
})();
