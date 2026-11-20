/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Rave Manji (Caudate IDE). All rights reserved.
 *  Portions Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../base/common/date.js';
import { isLinuxSnap } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { IOSProperties } from '../../native/common/native.js';
import { IProductService } from '../../product/common/productService.js';
import { process } from '../../../base/parts/sandbox/electron-browser/globals.js';

export function createNativeAboutDialogDetails(productService: IProductService, osProps: IOSProperties): { title: string; details: string; detailsToCopy: string } {
	let vscodeVersion = productService.version;
	if (productService.target) {
		vscodeVersion = `${vscodeVersion} (${productService.target} setup)`;
	} else if (productService.darwinUniversalAssetId) {
		vscodeVersion = `${vscodeVersion} (Universal)`;
	}

	const caudateVersion = productService.caudateVersion || '1.0.0';
	const caudateAiVersion = productService.caudateAiVersion || '2.0.0';
	const developer = productService.developer || 'Rave Manji';
	const licenseName = productService.licenseName || 'MIT';

	const getDetails = (useAgo: boolean): string => {
		return localize({ key: 'aboutDetail', comment: ['Caudate IDE, Electron, Chromium, Node.js and V8 are product names that need no translation'] },
			"Caudate IDE Version: {0}\nDeveloper: {1}\nRepository: https://github.com/raveuk/Caudate-AI-VSCODE\nAI Engine: Caudate AI {2} (OpenAI-Compatible · Ollama · LM Studio · MCP)\nVS Code (Code - OSS): {3}\nCommit: {4}\nDate: {5}\nElectron: {6}\nChromium: {7}\nNode.js: {8}\nV8: {9}\nOS: {10}\nLicense: {11} License (Free for personal, academic & commercial use)\nCopyright © 2026 {1}. Based on Code - OSS (Microsoft Corporation, MIT).",
			caudateVersion,
			developer,
			caudateAiVersion,
			vscodeVersion,
			productService.commit || 'Local Build',
			productService.date ? `${productService.date}${useAgo ? ' (' + fromNow(new Date(productService.date), true) + ')' : ''}` : 'Local Build',
			process.versions['electron'],
			process.versions['chrome'],
			process.versions['node'],
			process.versions['v8'],
			`${osProps.type} ${osProps.arch} ${osProps.release}${isLinuxSnap ? ' snap' : ''}`,
			licenseName
		);
	};

	const details = getDetails(true);
	const detailsToCopy = getDetails(false);

	return {
		title: productService.nameLong,
		details: details,
		detailsToCopy: detailsToCopy
	};
}
