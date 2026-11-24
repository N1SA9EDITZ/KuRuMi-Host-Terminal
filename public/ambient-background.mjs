import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient-backdrop';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' });
    } catch {
        canvas.remove();
    }

    if (renderer) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 80);
        camera.position.z = 19;

        const geometryRoot = new THREE.Group();
        scene.add(geometryRoot);

        function addWireShape(geometry, color, opacity, x, y) {
            const edges = new THREE.EdgesGeometry(geometry, 12);
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
            const lines = new THREE.LineSegments(edges, material);
            lines.position.set(x, y, -3);
            geometryRoot.add(lines);
            return lines;
        }

        const narrowScreen = window.innerWidth < 700;
        const leftShape = addWireShape(new THREE.IcosahedronGeometry(4.8, 1), 0x9d78ff, 0.3, narrowScreen ? -5.8 : -8.5, 2.2);
        const rightShape = addWireShape(new THREE.OctahedronGeometry(3.2, 1), 0x56cde8, 0.2, narrowScreen ? 5.2 : 8.1, -2.4);
        const smallShape = addWireShape(new THREE.TetrahedronGeometry(1.7, 1), 0xb98aff, 0.22, narrowScreen ? 4.1 : -2.5, -5.8);

        const pointPositions = [];
        const linkPositions = [];
        const nodes = [];
        for (let index = 0; index < 70; index++) {
            const angle = index * 2.399963;
            const radius = 2.2 + (index % 11) * 0.58;
            const node = new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle * 0.71) * 6.2, ((index * 17) % 13) - 6);
            nodes.push(node);
            pointPositions.push(node.x, node.y, node.z);
        }

        for (let left = 0; left < nodes.length; left++) {
            for (let right = left + 1; right < nodes.length; right++) {
                if (nodes[left].distanceTo(nodes[right]) < 3.15 && linkPositions.length < 720) {
                    linkPositions.push(nodes[left].x, nodes[left].y, nodes[left].z, nodes[right].x, nodes[right].y, nodes[right].z);
                }
            }
        }

        const pointGeometry = new THREE.BufferGeometry();
        pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
        const points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ color: 0xc3a3ff, size: 0.045, transparent: true, opacity: 0.5, sizeAttenuation: true }));
        scene.add(points);

        const linkGeometry = new THREE.BufferGeometry();
        linkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linkPositions, 3));
        const links = new THREE.LineSegments(linkGeometry, new THREE.LineBasicMaterial({ color: 0x6a58a2, transparent: true, opacity: 0.2 }));
        scene.add(links);

        const burstCount = narrowScreen ? 36 : 64;
        const burstPositions = new Float32Array(burstCount * 3);
        const burstVelocity = new Float32Array(burstCount * 3);
        const burstLife = new Float32Array(burstCount);
        for (let index = 0; index < burstCount; index++) burstPositions[index * 3 + 1] = -1000;
        const burstGeometry = new THREE.BufferGeometry();
        burstGeometry.setAttribute('position', new THREE.BufferAttribute(burstPositions, 3));
        const bursts = new THREE.Points(burstGeometry, new THREE.PointsMaterial({ color: 0x95ddff, size: 0.075, transparent: true, opacity: 0.88, sizeAttenuation: true }));
        scene.add(bursts);

        const rainCount = narrowScreen ? 16 : 30;
        const rainPositions = new Float32Array(rainCount * 6);
        const rainVelocity = new Float32Array(rainCount * 3);
        const rainLife = new Float32Array(rainCount);
        for (let index = 0; index < rainCount; index++) rainPositions[index * 6 + 1] = -1000;
        const rainGeometry = new THREE.BufferGeometry();
        rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
        const rain = new THREE.LineSegments(rainGeometry, new THREE.LineBasicMaterial({ color: 0x6ed9ee, transparent: true, opacity: 0.42 }));
        scene.add(rain);

        let burstCursor = 0;
        let rainCursor = 0;
        function createTouchBurst(clientX, clientY) {
            const distance = camera.position.z + 3;
            const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
            const originX = (clientX / window.innerWidth * 2 - 1) * halfHeight * camera.aspect;
            const originY = (1 - clientY / window.innerHeight * 2) * halfHeight;

            for (let count = 0; count < Math.min(24, burstCount); count++) {
                const index = burstCursor++ % burstCount;
                const offset = index * 3;
                const angle = Math.random() * Math.PI * 2;
                const speed = 2.2 + Math.random() * 4.2;
                burstPositions[offset] = originX;
                burstPositions[offset + 1] = originY;
                burstPositions[offset + 2] = -3 + Math.random() * 3;
                burstVelocity[offset] = Math.cos(angle) * speed;
                burstVelocity[offset + 1] = Math.sin(angle) * speed + 1.2;
                burstVelocity[offset + 2] = (Math.random() - 0.5) * 2.5;
                burstLife[index] = 0.9 + Math.random() * 0.75;
            }

            for (let count = 0; count < Math.min(14, rainCount); count++) {
                const index = rainCursor++ % rainCount;
                const offset = index * 6;
                const velocityOffset = index * 3;
                const x = originX + (Math.random() - 0.5) * 7;
                const y = originY + Math.random() * 2;
                const z = -2 + Math.random() * 3;
                rainPositions[offset] = x;
                rainPositions[offset + 1] = y;
                rainPositions[offset + 2] = z;
                rainPositions[offset + 3] = x + 0.08;
                rainPositions[offset + 4] = y + 0.34;
                rainPositions[offset + 5] = z;
                rainVelocity[velocityOffset] = (Math.random() - 0.5) * 0.6;
                rainVelocity[velocityOffset + 1] = -(3 + Math.random() * 3);
                rainVelocity[velocityOffset + 2] = 0;
                rainLife[index] = 0.9 + Math.random() * 0.7;
            }
        }

        document.addEventListener('pointerdown', event => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            createTouchBurst(event.clientX, event.clientY);
        }, { passive: true });

        let targetScroll = window.scrollY;
        let smoothScroll = targetScroll;
        window.addEventListener('scroll', () => { targetScroll = window.scrollY; }, { passive: true });

        if ('IntersectionObserver' in window) {
            const revealObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('ambient-visible');
                        revealObserver.unobserve(entry.target);
                    }
                }
            }, { threshold: 0.12 });

            const observeReveal = element => {
                if (!element.matches('.ambient-reveal')) element.classList.add('ambient-reveal');
                revealObserver.observe(element);
            };
            document.querySelectorAll('.plan, .checkout, .table-wrap, .instance-card, .order').forEach(observeReveal);
            const revealMutation = new MutationObserver(records => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.matches('.instance-card, .order')) observeReveal(node);
                        node.querySelectorAll?.('.instance-card, .order').forEach(observeReveal);
                    }
                }
            });
            revealMutation.observe(document.body, { childList: true, subtree: true });
        }

        let lastFrame = 0;
        function animate(timestamp) {
            window.requestAnimationFrame(animate);
            if (document.hidden || timestamp - lastFrame < 33) return;
            const delta = Math.min((timestamp - lastFrame) / 1000, 0.05);
            lastFrame = timestamp;
            const time = timestamp * 0.001;
            leftShape.rotation.x = time * 0.07;
            leftShape.rotation.y = time * 0.11;
            rightShape.rotation.x = -time * 0.1;
            rightShape.rotation.y = time * 0.08;
            smallShape.rotation.x = time * 0.12;
            smallShape.rotation.z = -time * 0.07;
            smoothScroll += (targetScroll - smoothScroll) * 0.035;
            geometryRoot.position.y = Math.sin(time * 0.22) * 0.24 + Math.sin(smoothScroll * 0.0012) * 0.2;
            geometryRoot.rotation.z = Math.sin(smoothScroll * 0.0007) * 0.025;
            points.rotation.y = time * 0.009;
            links.rotation.y = time * 0.009;
            for (let index = 0; index < burstCount; index++) {
                if (burstLife[index] <= 0) continue;
                const offset = index * 3;
                burstVelocity[offset + 1] -= 2.5 * delta;
                burstPositions[offset] += burstVelocity[offset] * delta;
                burstPositions[offset + 1] += burstVelocity[offset + 1] * delta;
                burstPositions[offset + 2] += burstVelocity[offset + 2] * delta;
                burstLife[index] -= delta;
                if (burstLife[index] <= 0) burstPositions[offset + 1] = -1000;
            }
            for (let index = 0; index < rainCount; index++) {
                if (rainLife[index] <= 0) continue;
                const offset = index * 6;
                const velocityOffset = index * 3;
                const movementX = rainVelocity[velocityOffset] * delta;
                const movementY = rainVelocity[velocityOffset + 1] * delta;
                rainPositions[offset] += movementX;
                rainPositions[offset + 1] += movementY;
                rainPositions[offset + 3] += movementX;
                rainPositions[offset + 4] += movementY;
                rainLife[index] -= delta;
                if (rainLife[index] <= 0) rainPositions[offset + 1] = -1000;
            }
            burstGeometry.attributes.position.needsUpdate = true;
            rainGeometry.attributes.position.needsUpdate = true;
            renderer.render(scene, camera);
        }

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight, false);
        });

        window.requestAnimationFrame(animate);
    }
}
