const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('error') === 'true') {
    const errorMsg = document.getElementById('errorMsg');
    errorMsg.style.display = 'block';
}
