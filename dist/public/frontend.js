'use strict';

console.log('BMP plugin: Frontend script loaded');

function isBmpFile(entry) {
    return entry && entry.ext && entry.ext.toLowerCase() === 'bmp';
}

function ImgFallback({ fallback, props, entry }) {
    const { h, React } = HFS;
    const [error, setError] = React.useState(false);

    const handleClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        HFS.fileShow(entry, { startPlaying: true });
    };

    if (error && fallback) {
        const defaultIcon = fallback();
        return React.cloneElement(defaultIcon, {
            onClick: handleClick,
            style: {
                cursor: 'pointer',
                ...defaultIcon.props.style
            }
        });
    }

    return h('img', Object.assign(props, {
        onError: () => setError(true),
        onClick: handleClick
    }));
}

HFS.onEvent('fileShow', ({ entry }) => {
    if (isBmpFile(entry)) {
        return function BmpViewer(props) {
            const React = HFS.React;
            const { src, ...otherProps } = props;
            const jpgUrl = src + (src.includes('?') ? '&' : '?') + 'convert=bmp';

            return React.createElement('img', {
                src: jpgUrl,
                alt: entry.name,
                style: {
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain'
                },
                ...otherProps
            });
        };
    }
});

HFS.onEvent('isShowSupported', ({ entry }) => {
    if (isBmpFile(entry)) {
        return true;
    }
});

HFS.onEvent('entryIcon', ({ entry }) => {
    if (isBmpFile(entry)) {
        const { h } = HFS;

        return h(ImgFallback, {
            fallback: () => entry.getDefaultIcon ? entry.getDefaultIcon() : null,
            props: {
                src: entry.uri + '?get=thumbbmp',
                className: 'icon thumbnail',
                loading: 'lazy',
                alt: entry.name,
                style: { cursor: 'pointer' }
            },
            entry: entry
        });
    }
});